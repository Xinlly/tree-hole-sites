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
import { encodeCursor } from "./cursor.ts";
import type {
  ListOptions,
  Page,
  Store,
  StoredEntry,
  StoredMessage,
} from "./types.ts";

const ACTIVE_MAX = 20;
const STATE_VERSION = 2;
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

export class ObjectStore implements Store {
  private client: S3Client;
  private newId: () => string;
  private tails: Record<CollectionName, Promise<void>> = {
    [MESSAGES]: Promise.resolve(),
    [ENTRIES]: Promise.resolve(),
  };

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
    await Promise.all([
      this.enqueue(MESSAGES, () => this.initializeCollection(MESSAGES)),
      this.enqueue(ENTRIES, () => this.initializeCollection(ENTRIES)),
    ]);
  }

  listMessages(options: ListOptions) {
    return this.readPage<StoredMessage>(MESSAGES, options);
  }

  async createMessage(nickname: string, content: string) {
    await this.enqueue(MESSAGES, () =>
      this.append<StoredMessage>(MESSAGES, {
        id: this.newId(),
        nickname,
        content,
        createdAt: currentTimestamp(),
      }),
    );
  }

  async deleteMessage(id: string) {
    await this.enqueue(MESSAGES, () => this.remove(MESSAGES, id));
  }

  listEntries(options: ListOptions) {
    return this.readPage<StoredEntry>(ENTRIES, options);
  }

  async createEntry(mood: string, content: string, reply: string) {
    await this.enqueue(ENTRIES, () =>
      this.append<StoredEntry>(ENTRIES, {
        id: this.newId(),
        mood,
        content,
        reply,
        createdAt: currentTimestamp(),
      }),
    );
  }

  async deleteEntry(id: string) {
    await this.enqueue(ENTRIES, () => this.remove(ENTRIES, id));
  }

  private enqueue<T>(name: CollectionName, task: () => Promise<T>): Promise<T> {
    const run = this.tails[name].then(() => task());
    // 内部兜底 catch：失败只作用于当次请求，不污染链尾
    this.tails[name] = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async initializeCollection(name: CollectionName) {
    try {
      await this.getObject(stateKey(name));
    } catch (error) {
      if (isNoSuchKey(error)) {
        await this.putState(name, { active: [], headBlockKey: null });
      } else {
        throw error;
      }
    }
  }

  private async append<T>(name: CollectionName, item: T) {
    const state = await this.readState<T>(name);
    state.active.unshift(item); // active 新在前（id 倒序）
    if (state.active.length < ACTIVE_MAX) {
      await this.putState(name, state);
      return;
    }

    // >=20：先写不可变封存块（取最旧 20），后写 state
    const length = state.active.length;
    const sealed = state.active.slice(length - ACTIVE_MAX);
    const blockId = this.newId();
    const key = blockKey(name, blockId);
    await this.putObject(
      key,
      gzipSync(
        Buffer.from(JSON.stringify({ id: blockId, items: sealed }), "utf8"),
      ),
    );
    state.active = state.active.slice(0, length - ACTIVE_MAX);
    state.headBlockKey = key;
    await this.putState(name, state);
  }

  private async remove<T>(name: CollectionName, id: string) {
    const state = await this.readState<T>(name);

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
      await this.putState(name, state);
    }
  }

  private async readPage<T>(
    name: CollectionName,
    options: ListOptions,
  ): Promise<Page<T>> {
    // 乐观并行 GET：state 与 tombstones 并行；headBlock 读到 headBlockKey 后立即 GET
    const stateP = this.readState<T>(name);
    const tombstonesP = this.readTombstones(tombstonesKey(name));
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
      await this.collectBlocks<T>(name, undefined, locations, seen, alive, need);
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
    await this.collectBlocks<T>(name, hintBlockKey, locations, seen, alive, need);
  }

  // LIST 块链并收集存活项，唯一 id 收满 need 即停；StartAfter 使深分页不逐块 GET 新块
  private async collectBlocks<T>(
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
        Prefix: `v2/${name}/blocks/`,
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

  private async readState<T>(name: CollectionName): Promise<State<T>> {
    let text: string;
    try {
      text = await this.getObject(stateKey(name));
    } catch (error) {
      if (isNoSuchKey(error)) {
        // §4.1.1：state 缺失视为空活动区、无块
        return {
          version: STATE_VERSION,
          active: [],
          headBlockKey: null,
          tombstonesKey: tombstonesKey(name),
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
      throw new Error(`Invalid state object in ${stateKey(name)}`);
    }
    return value;
  }

  private putState<T>(name: CollectionName, state: { active: T[]; headBlockKey: string | null }) {
    const full: State<T> = {
      version: STATE_VERSION,
      active: state.active,
      headBlockKey: state.headBlockKey,
      tombstonesKey: tombstonesKey(name),
      updatedAt: Date.now(),
    };
    return this.putObject(
      stateKey(name),
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

function stateKey(name: CollectionName) {
  return `v2/${name}/state.json.gz`;
}

function tombstonesKey(name: CollectionName) {
  return `v2/${name}/tombstones.json.gz`;
}

function blockKey(name: CollectionName, blockId: string) {
  return `v2/${name}/blocks/${invertUlid(blockId)}.json.gz`;
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
    transformToString?: () => Promise<string>;
  };
  if (typeof stream.transformToString === "function") {
    const text = await stream.transformToString();
    return new TextDecoder().decode(gunzipSync(Buffer.from(text, "binary")));
  }
  throw new Error("Unsupported S3 object body");
}

function isNoSuchKey(error: unknown): boolean {
  const target = error as { name?: string; Code?: string } | null;
  return target?.name === "NoSuchKey" || target?.Code === "NoSuchKey";
}
