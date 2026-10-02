import { Buffer } from "node:buffer";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { gunzipSync, gzipSync } from "node:zlib";
import { monotonicFactory } from "ulid";
import {
  blockKeyMatchesScope,
  encodeCursor,
} from "./cursor.ts";
import {
  ConflictError,
  LockedError,
  NotFoundError,
} from "./types.ts";
import type {
  AccountPatch,
  EntryPatch,
  ListOptions,
  MessagePatch,
  MutateOptions,
  Page,
  PassSpaceInfo,
  Scope,
  StoredAccount,
  StoredEntry,
  StoredMessage,
  Store,
} from "./types.ts";

const ACTIVE_MAX = 20;
const STATE_VERSION = 3;
const MESSAGES = "messages";
const ENTRIES = "entries";

type CollectionName = typeof MESSAGES | typeof ENTRIES;

type State<T> = {
  version: number;
  active: T[];
  headBlockKey: string | null;
  tombstonesKey: string;
  updatedAt: number;
};

type Block<T> = {
  id: string;
  items: T[];
};

type Location<T> = {
  item: T;
  blockKey?: string;
  index?: number;
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const USERS_KEY = "v3/users/state.json.gz";
const PASS_INDEX_KEY = "v3/pass-space-index.json.gz";
const USERS_QUEUE = "__users__";
const PASS_INDEX_QUEUE = "__pass_index__";

type UsersDocument = {
  version: number;
  users: StoredAccount[];
};

export class ObjectStore implements Store {
  private client: S3Client;
  private newId: () => string;
  // 每“空间×集合”一个串行队列；users 与 pass-space-index 各独立队列
  private tails = new Map<string, Promise<void>>();

  constructor() {
    this.client = new S3Client({
      region: process.env.STORAGE_OBJECT_REGION,
      endpoint: process.env.STORAGE_OBJECT_ENDPOINT,
      credentials: {
        accessKeyId: process.env.STORAGE_OBJECT_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.STORAGE_OBJECT_SECRET_ACCESS_KEY as string,
      },
      requestHandler: new NodeHttpHandler({
        requestTimeout: 5000,
        connectionTimeout: 3000,
      }),
    });
    // 条目 id 与块 id 共用同一 monotonic 工厂实例
    this.newId = monotonicFactory();
  }

  async ensureInitialized() {
    // 容器按需惰性初始化；此处不预建任何空间
  }

  // —— 留言 ——

  listMessages(scope: Scope, options: ListOptions) {
    return this.readPage<StoredMessage>(scope, MESSAGES, options);
  }

  async createMessage(scope: Scope, nickname: string, content: string) {
    await this.enqueue(queueKey(scope, MESSAGES), () =>
      this.append<StoredMessage>(scope, MESSAGES, {
        id: this.newId(),
        scopeKind: scope.kind,
        scopeId: scope.id,
        nickname,
        content,
        locked: false,
        createdAt: currentTimestamp(),
      }));
  }

  async updateMessage(scope: Scope, id: string, patch: MessagePatch, options?: MutateOptions) {
    await this.enqueue(queueKey(scope, MESSAGES), () =>
      this.mutateItem(scope, MESSAGES, id, (item) => {
        const message = item as StoredMessage;
        if (patch.nickname !== undefined) message.nickname = patch.nickname;
        if (patch.content !== undefined) message.content = patch.content;
      }, options?.bypassLock ?? false));
  }

  async setMessageLocked(scope: Scope, id: string, locked: boolean, options?: MutateOptions) {
    await this.enqueue(queueKey(scope, MESSAGES), () =>
      this.mutateItem(scope, MESSAGES, id, (item) => {
        (item as StoredMessage).locked = locked;
      }, options?.bypassLock ?? false));
  }

  async deleteMessage(scope: Scope, id: string) {
    await this.enqueue(queueKey(scope, MESSAGES), () =>
      this.remove(scope, MESSAGES, id));
  }

  // —— 封存 ——

  listEntries(scope: Scope, options: ListOptions) {
    return this.readPage<StoredEntry>(scope, ENTRIES, options);
  }

  async createEntry(scope: Scope, mood: string, content: string) {
    await this.enqueue(queueKey(scope, ENTRIES), () =>
      this.append<StoredEntry>(scope, ENTRIES, {
        id: this.newId(),
        scopeKind: scope.kind,
        scopeId: scope.id,
        mood,
        content,
        reply: "", // 任何创建都不写回复；回复一律走 :id/reply
        locked: false,
        createdAt: currentTimestamp(),
      }));
  }

  async updateEntry(scope: Scope, id: string, patch: EntryPatch, options?: MutateOptions) {
    await this.enqueue(queueKey(scope, ENTRIES), () =>
      this.mutateItem(scope, ENTRIES, id, (item) => {
        const entry = item as StoredEntry;
        if (patch.mood !== undefined) entry.mood = patch.mood;
        if (patch.content !== undefined) entry.content = patch.content;
      }, options?.bypassLock ?? false));
  }

  async setEntryReply(scope: Scope, id: string, reply: string) {
    await this.enqueue(queueKey(scope, ENTRIES), () =>
      this.mutateItem(scope, ENTRIES, id, (item) => {
        (item as StoredEntry).reply = reply;
      }, true));
  }

  async setEntryLocked(scope: Scope, id: string, locked: boolean, options?: MutateOptions) {
    await this.enqueue(queueKey(scope, ENTRIES), () =>
      this.mutateItem(scope, ENTRIES, id, (item) => {
        (item as StoredEntry).locked = locked;
      }, options?.bypassLock ?? false));
  }

  async deleteEntry(scope: Scope, id: string) {
    await this.enqueue(queueKey(scope, ENTRIES), () =>
      this.remove(scope, ENTRIES, id));
  }

  // —— 账号（§4.4）——

  async listUsers() {
    return this.enqueue(USERS_QUEUE, async () => (await this.readUsers()).users);
  }

  async createUser(username: string, passwordHash: string) {
    return this.enqueue(USERS_QUEUE, async () => {
      const doc = await this.readUsers();
      const lowered = username.toLowerCase();
      if (doc.users.some((user) => user.username.toLowerCase() === lowered)) {
        throw new ConflictError("username already exists");
      }
      const account: StoredAccount = {
        id: this.newId(),
        username,
        passwordHash,
        active: true,
        tokenVersion: 1,
        createdAt: currentTimestamp(),
      };
      doc.users.push(account);
      await this.writeUsers(doc);
      return account;
    });
  }

  async updateUser(id: string, patch: AccountPatch) {
    return this.enqueue(USERS_QUEUE, async () => {
      const doc = await this.readUsers();
      const account = doc.users.find((user) => user.id === id);
      if (!account) {
        throw new NotFoundError("user not found");
      }
      if (patch.passwordHash !== undefined) {
        account.passwordHash = patch.passwordHash;
        account.tokenVersion += 1; // 旧令牌立即失效
      }
      if (patch.active !== undefined) {
        account.active = patch.active; // 重新启用不 bump（§4.4）
      }
      await this.writeUsers(doc);
      return account;
    });
  }

  // —— 口令空间索引（§4.5）——

  async listPassSpaces() {
    return this.enqueue(PASS_INDEX_QUEUE, () => this.readPassIndex());
  }

  async ensurePassSpace(id: string, label?: string) {
    return this.enqueue(PASS_INDEX_QUEUE, async () => {
      const index = await this.readPassIndex();
      const existing = index.find((info) => info.id === id);
      if (existing) {
        // 标签只在缺失时补写，不覆盖已有标签
        if (!existing.label && label) {
          existing.label = label;
          await this.putObject(
            PASS_INDEX_KEY,
            gzipSync(Buffer.from(JSON.stringify(index), "utf8")),
          );
        }
        return existing;
      }
      const info: PassSpaceInfo = { id, createdAt: currentTimestamp() };
      if (label) info.label = label;
      index.push(info);
      await this.putObject(
        PASS_INDEX_KEY,
        gzipSync(Buffer.from(JSON.stringify(index), "utf8")),
      );
      return info;
    });
  }

  // —— 内部：队列 ——

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(key) ?? Promise.resolve();
    const run = tail.then(() => task());
    // 内部兜底 catch：失败只作用于当次请求，不污染链尾
    this.tails.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  // —— 内部：分块容器（复用 v2 chunked 机制）——

  private async append<T>(scope: Scope, name: CollectionName, item: T) {
    const state = await this.readState<T>(scope, name);
    state.active.unshift(item); // active 新在前（id 倒序）
    if (state.active.length < ACTIVE_MAX) {
      await this.putState(scope, name, state);
      return;
    }

    // >=20：先写不可变封存块（取最旧 20），后写 state
    const length = state.active.length;
    const sealed = state.active.slice(length - ACTIVE_MAX);
    const blockId = this.newId();
    const key = buildBlockKey(scope, name, blockId);
    await this.putObject(
      key,
      gzipSync(
        Buffer.from(JSON.stringify({ id: blockId, items: sealed }), "utf8"),
      ),
    );
    state.active = state.active.slice(0, length - ACTIVE_MAX);
    state.headBlockKey = key;
    await this.putState(scope, name, state);
  }

  private async remove<T>(scope: Scope, name: CollectionName, id: string) {
    const state = await this.readState<T>(scope, name);

    // 统一删除：先把 id 落墓碑（去重追加），使删除事实跨对象持久化，
    // 否则崩溃遗留的孤儿块仍持该 id，深翻页会让已删项复活。
    const tombstones = await this.readTombstones(state.tombstonesKey);
    if (!tombstones.includes(id)) {
      await this.putTombstones(state.tombstonesKey, [...tombstones, id]);
    }

    // 墓碑成功后再改 state：id 在 active 则移除；在封存块则 state 不变。
    const activeIndex = state.active.findIndex(
      (item) => (item as { id: string }).id === id,
    );
    if (activeIndex >= 0) {
      state.active.splice(activeIndex, 1);
      await this.putState(scope, name, state);
    }
  }

  // §5.1 原地改：active 内随 state 整写；封存块内定位 id → 读-改-同键整体覆盖。
  private async mutateItem<T>(
    scope: Scope,
    name: CollectionName,
    id: string,
    apply: (item: T) => void,
    bypassLock: boolean,
  ) {
    const state = await this.readState<T>(scope, name);
    const tombstones = new Set(
      await this.readTombstones(state.tombstonesKey),
    );
    if (tombstones.has(id)) {
      throw new NotFoundError(`${name} item not found`);
    }

    const lockedItem = (item: { locked?: boolean }) =>
      !bypassLock && item.locked === true;

    const activeItem = state.active.find(
      (item) => (item as { id: string }).id === id,
    );
    if (activeItem) {
      if (lockedItem(activeItem as { locked?: boolean })) {
        throw new LockedError("item is locked");
      }
      apply(activeItem);
      (activeItem as { updatedAt?: string }).updatedAt = currentTimestamp();
      await this.putState(scope, name, state);
      return;
    }

    // 从最新块向更旧块逐个定位（块键反转 ULID，LIST 升序即新→旧）
    let blockKeyToRead = state.headBlockKey;
    while (blockKeyToRead) {
      const block = await this.readBlock<T>(blockKeyToRead);
      const index = block.items.findIndex(
        (item) => (item as { id: string }).id === id,
      );
      if (index >= 0) {
        if (lockedItem(block.items[index] as { locked?: boolean })) {
          throw new LockedError("item is locked");
        }
        apply(block.items[index]);
        (block.items[index] as { updatedAt?: string }).updatedAt =
          currentTimestamp();
        await this.putObject(
          blockKeyToRead,
          gzipSync(Buffer.from(JSON.stringify(block), "utf8")),
        );
        return;
      }
      blockKeyToRead = await this.nextOlderBlockKey(
        scope,
        name,
        blockKeyToRead,
      );
    }
    throw new NotFoundError(`${name} item not found`);
  }

  // 取 LIST 升序中紧排在 currentKey 之后的块键（=更旧的下一块）
  private async nextOlderBlockKey(
    scope: Scope,
    name: CollectionName,
    currentKey: string,
  ): Promise<string | null> {
    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: process.env.STORAGE_OBJECT_BUCKET,
        Prefix: `${scopePrefix(scope)}/${name}/blocks/`,
        StartAfter: currentKey,
        MaxKeys: 1,
      }),
    );
    return response.Contents?.[0]?.Key ?? null;
  }

  private async readPage<T>(
    scope: Scope,
    name: CollectionName,
    options: ListOptions,
  ): Promise<Page<T>> {
    if (
      options.blockKey !== undefined &&
      !blockKeyMatchesScope(options.blockKey, scope)
    ) {
      throw new Error("invalid cursor");
    }
    // 乐观并行 GET：state 与 tombstones 并行；headBlock 读到 headBlockKey 后立即 GET
    const stateP = this.readState<T>(scope, name);
    const tombstonesP = this.readTombstones(buildTombstonesKey(scope, name));
    const headBlockP = stateP.then((state) => {
      if (!state.headBlockKey) {
        return null;
      }
      return this.readBlock<T>(state.headBlockKey).catch((error: unknown) => {
        if (isNoSuchKey(error)) {
          return null;
        }
        throw error;
      });
    });
    const [state, tombstonesList, headBlock] = await Promise.all([
      stateP,
      tombstonesP,
      headBlockP,
    ]);
    const tombstones = new Set(tombstonesList);
    const locations: Location<T>[] = [];
    // 收集期去重：重复 id（孤儿块/重放）既不 push、也不占名额，
    // 使两个收集方法按「唯一 id 数」提前停止，不漏条。
    const seen = new Set<string>();
    const alive = (item: { id: string }) =>
      (!options.afterId || item.id < options.afterId) &&
      !tombstones.has(item.id);
    const collect = (item: T, blockKey?: string, index?: number) => {
      const id = (item as { id: string }).id;
      if (alive(item as { id: string }) && !seen.has(id)) {
        seen.add(id);
        locations.push({ item, blockKey, index });
      }
    };

    if (options.blockKey !== undefined) {
      await this.collectFromHint<T>(
        scope,
        name,
        options.blockKey,
        options.index,
        locations,
        seen,
        alive,
        options.limit + 1,
      );
    } else {
      // 首屏 / afterId 落在 active：active 全量 + headBlock 直取，不发 LIST
      for (const item of state.active) {
        collect(item);
      }
      if (headBlock) {
        const headKey = state.headBlockKey as string;
        headBlock.items.forEach((item, index) => collect(item, headKey, index));
      }
      // 唯一候选不足 limit+1 且可能存在更旧块时，才回退 LIST
      if (seen.size < options.limit + 1 && state.headBlockKey) {
        const startAfter = headBlock ? state.headBlockKey : undefined;
        await this.collectBlocks<T>(
          scope,
          name,
          startAfter,
          locations,
          seen,
          alive,
          options.limit + 1,
        );
      }
    }

    // 多块结果统一按 id 降序（ULID 字典序），消除 LIST 乱序
    locations.sort((a, b) => {
      const ai = (a.item as { id: string }).id;
      const bi = (b.item as { id: string }).id;
      return ai === bi ? 0 : ai < bi ? 1 : -1;
    });
    // 二次防线：收集期已用 seen 去重，此处按 sort 后相邻同 id 再兜一次
    const deduped: Location<T>[] = [];
    for (const location of locations) {
      const id = (location.item as { id: string }).id;
      if (
        deduped.length === 0 ||
        (deduped[deduped.length - 1].item as { id: string }).id !== id
      ) {
        deduped.push(location);
      }
    }

    const hasMore = deduped.length > options.limit;
    const returned = deduped.slice(0, options.limit);
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = returned[returned.length - 1];
      const afterId = (last.item as { id: string }).id;
      nextCursor = last.blockKey
        ? encodeCursor({ afterId, blockKey: last.blockKey, index: last.index })
        : encodeCursor({ afterId });
    }
    return { items: returned.map((entry) => entry.item), nextCursor, hasMore };
  }

  // 从 cursor 块提示起收集：hint 块 index 之后 → 更旧块；提示块 404 则回退全链 LIST
  private async collectFromHint<T>(
    scope: Scope,
    name: CollectionName,
    hintBlockKey: string,
    hintIndex: number | undefined,
    locations: Location<T>[],
    seen: Set<string>,
    alive: (item: { id: string }) => boolean,
    need: number,
  ): Promise<void> {
    let hintBlock: Block<T>;
    try {
      hintBlock = await this.readBlock<T>(hintBlockKey);
    } catch (error) {
      if (!isNoSuchKey(error)) {
        throw error;
      }
      // 提示失效：回退为从头 LIST 全块（active 项 id 均 > afterId，已被过滤）
      await this.collectBlocks<T>(
        scope,
        name,
        undefined,
        locations,
        seen,
        alive,
        need,
      );
      return;
    }
    const start = Math.min((hintIndex ?? -1) + 1, hintBlock.items.length);
    for (let i = start; i < hintBlock.items.length; i += 1) {
      const item = hintBlock.items[i];
      const id = (item as { id: string }).id;
      if (alive(item as { id: string }) && !seen.has(id)) {
        seen.add(id);
        locations.push({ item, blockKey: hintBlockKey, index: i });
        if (seen.size >= need) return;
      }
    }
    await this.collectBlocks<T>(
      scope,
      name,
      hintBlockKey,
      locations,
      seen,
      alive,
      need,
    );
  }

  // LIST 块链并收集存活项，唯一 id 收满 need 即停；StartAfter 使深分页不逐块 GET 新块
  private async collectBlocks<T>(
    scope: Scope,
    name: CollectionName,
    startAfter: string | undefined,
    locations: Location<T>[],
    seen: Set<string>,
    alive: (item: { id: string }) => boolean,
    need: number,
  ): Promise<void> {
    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: process.env.STORAGE_OBJECT_BUCKET,
        Prefix: `${scopePrefix(scope)}/${name}/blocks/`,
        StartAfter: startAfter,
        MaxKeys: 1000,
      }),
    );
    for (const entry of response.Contents ?? []) {
      if (!entry.Key) {
        continue;
      }
      const block = await this.readBlock<T>(entry.Key);
      for (let i = 0; i < block.items.length; i += 1) {
        const item = block.items[i];
        const id = (item as { id: string }).id;
        if (alive(item as { id: string }) && !seen.has(id)) {
          seen.add(id);
          locations.push({ item, blockKey: entry.Key, index: i });
          if (seen.size >= need) {
            return;
          }
        }
      }
    }
  }

  private async readState<T>(
    scope: Scope,
    name: CollectionName,
  ): Promise<State<T>> {
    let text: string;
    try {
      text = await this.getObject(buildStateKey(scope, name));
    } catch (error) {
      if (isNoSuchKey(error)) {
        // state 缺失视为空活动区、无块
        return {
          version: STATE_VERSION,
          active: [],
          headBlockKey: null,
          tombstonesKey: buildTombstonesKey(scope, name),
          updatedAt: 0,
        };
      }
      throw error;
    }
    const value = JSON.parse(text) as State<T>;
    if (
      value.version !== STATE_VERSION ||
      !Array.isArray(value.active) ||
      !(value.headBlockKey === null || typeof value.headBlockKey === "string") ||
      typeof value.tombstonesKey !== "string"
    ) {
      throw new Error(
        `Invalid state object in ${buildStateKey(scope, name)}`,
      );
    }
    return value;
  }

  private putState<T>(
    scope: Scope,
    name: CollectionName,
    state: State<T>,
  ) {
    const full: State<T> = {
      version: STATE_VERSION,
      active: state.active,
      headBlockKey: state.headBlockKey,
      tombstonesKey: buildTombstonesKey(scope, name),
      updatedAt: Date.now(),
    };
    return this.putObject(
      buildStateKey(scope, name),
      gzipSync(Buffer.from(JSON.stringify(full), "utf8")),
    );
  }

  private async readBlock<T>(key: string): Promise<Block<T>> {
    const value = JSON.parse(await this.getObject(key)) as Block<T>;
    if (typeof value.id !== "string" || !Array.isArray(value.items)) {
      throw new Error(`Invalid block object in ${key}`);
    }
    return value;
  }

  private async readTombstones(key: string): Promise<string[]> {
    try {
      const value = JSON.parse(await this.getObject(key)) as unknown;
      if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
        throw new Error(`Invalid tombstones object in ${key}`);
      }
      return value as string[];
    } catch (error) {
      if (isNoSuchKey(error)) {
        return [];
      }
      throw error;
    }
  }

  private putTombstones(key: string, ids: string[]) {
    return this.putObject(
      key,
      gzipSync(Buffer.from(JSON.stringify(ids), "utf8")),
    );
  }

  // —— 内部：users 文档 / pass 索引 ——

  private async readUsers(): Promise<UsersDocument> {
    try {
      const value = JSON.parse(await this.getObject(USERS_KEY)) as UsersDocument;
      if (value.version !== STATE_VERSION || !Array.isArray(value.users)) {
        throw new Error(`Invalid users object in ${USERS_KEY}`);
      }
      return value;
    } catch (error) {
      if (isNoSuchKey(error)) {
        return { version: STATE_VERSION, users: [] };
      }
      throw error;
    }
  }

  private writeUsers(doc: UsersDocument) {
    return this.putObject(
      USERS_KEY,
      gzipSync(Buffer.from(JSON.stringify(doc), "utf8")),
    );
  }

  private async readPassIndex(): Promise<PassSpaceInfo[]> {
    try {
      const value = JSON.parse(await this.getObject(PASS_INDEX_KEY));
      if (
        !Array.isArray(value) ||
        value.some(
          (item) =>
            typeof item?.id !== "string" ||
            typeof item.createdAt !== "string" ||
            (item.label !== undefined && typeof item.label !== "string"),
        )
      ) {
        throw new Error(`Invalid pass-space index in ${PASS_INDEX_KEY}`);
      }
      return value as PassSpaceInfo[];
    } catch (error) {
      if (isNoSuchKey(error)) {
        return [];
      }
      throw error;
    }
  }

  // —— 内部：S3 IO ——

  private async getObject(key: string): Promise<string> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: process.env.STORAGE_OBJECT_BUCKET,
        Key: key,
      }),
    );
    return readBody(response.Body);
  }

  private putObject(key: string, body: Buffer) {
    return this.client.send(
      new PutObjectCommand({
        Bucket: process.env.STORAGE_OBJECT_BUCKET,
        Key: key,
        Body: body,
        ContentType: "application/gzip",
      }),
    );
  }
}

// —— 键布局 ——

function scopePrefix(scope: Scope) {
  if (scope.kind === "public") {
    return "v3/public";
  }
  return `v3/${scope.kind}/${scope.id}`;
}

function queueKey(scope: Scope, name: CollectionName) {
  return `${scope.kind}:${scope.id}:${name}`;
}

function buildStateKey(scope: Scope, name: CollectionName) {
  return `${scopePrefix(scope)}/${name}/state.json.gz`;
}

function buildTombstonesKey(scope: Scope, name: CollectionName) {
  return `${scopePrefix(scope)}/${name}/tombstones.json.gz`;
}

function buildBlockKey(scope: Scope, name: CollectionName, blockId: string) {
  return `${scopePrefix(scope)}/${name}/blocks/${invertUlid(blockId)}.json.gz`;
}

// Crockford 字母表对称位置取反 f(i)=31−i：blockId 越大（新）→ inverted 越小 → LIST 升序越靠前
function invertUlid(value: string) {
  let result = "";
  for (const char of value) {
    result += CROCKFORD[31 - CROCKFORD.indexOf(char)];
  }
  return result;
}

function currentTimestamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(
    now.getUTCDate(),
  )} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(
    now.getUTCSeconds(),
  )}`;
}

async function readBody(body: unknown): Promise<string> {
  if (body == null) {
    return "";
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(gunzipSync(body));
  }
  if (typeof body === "string") {
    return new TextDecoder().decode(gunzipSync(Buffer.from(body, "binary")));
  }
  const stream = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    transformToString?: (encoding?: string) => Promise<string>;
  };
  // gzip 是二进制：必须按字节读取。默认 transformToString() 按 utf-8 解码会破坏字节，
  // 真机 AWS SDK 的 Body 是 SdkStream（非 Uint8Array），故优先 transformToByteArray。
  if (typeof stream.transformToByteArray === "function") {
    const bytes = await stream.transformToByteArray();
    return new TextDecoder().decode(gunzipSync(Buffer.from(bytes)));
  }
  if (typeof stream.transformToString === "function") {
    const text = await stream.transformToString("binary");
    return new TextDecoder().decode(gunzipSync(Buffer.from(text, "binary")));
  }
  throw new Error("Unsupported S3 object body");
}

function isNoSuchKey(error: unknown): boolean {
  const target = error as { name?: string; Code?: string } | null;
  return target?.name === "NoSuchKey" || target?.Code === "NoSuchKey";
}
