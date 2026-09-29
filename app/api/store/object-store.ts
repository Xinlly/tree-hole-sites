import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { Store, StoredEntry, StoredMessage } from "./types.ts";

const MESSAGE_KEY = "visitor-messages.json";
const ENTRY_KEY = "tree-hole-entries.json";
const MAX_ITEMS = 100;

type Collection<T> = {
  nextId: number;
  items: T[];
};

export class ObjectStore implements Store {
  private client: S3Client;
  private tails: Record<string, Promise<void>> = {
    [MESSAGE_KEY]: Promise.resolve(),
    [ENTRY_KEY]: Promise.resolve(),
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
  }

  async ensureInitialized() {
    await Promise.all([
      this.enqueue(MESSAGE_KEY, () => this.initializeCollection(MESSAGE_KEY)),
      this.enqueue(ENTRY_KEY, () => this.initializeCollection(ENTRY_KEY)),
    ]);
  }

  async listMessages() {
    return this.enqueue(MESSAGE_KEY, async () => {
      const data = await this.readCollection<StoredMessage>(MESSAGE_KEY);
      return [...data.items].reverse();
    });
  }

  async createMessage(nickname: string, content: string) {
    await this.enqueue(MESSAGE_KEY, async () => {
      const data = await this.readCollection<StoredMessage>(MESSAGE_KEY);
      data.items.push({
        id: data.nextId,
        nickname,
        content,
        createdAt: currentTimestamp(),
      });
      data.nextId += 1;
      this.trim(data);
      await this.writeCollection(MESSAGE_KEY, data);
    });
  }

  async deleteMessage(id: number) {
    await this.enqueue(MESSAGE_KEY, async () => {
      const data = await this.readCollection<StoredMessage>(MESSAGE_KEY);
      data.items = data.items.filter((item) => item.id !== id);
      await this.writeCollection(MESSAGE_KEY, data);
    });
  }

  async listEntries() {
    return this.enqueue(ENTRY_KEY, async () => {
      const data = await this.readCollection<StoredEntry>(ENTRY_KEY);
      return [...data.items].reverse();
    });
  }

  async createEntry(mood: string, content: string, reply: string) {
    await this.enqueue(ENTRY_KEY, async () => {
      const data = await this.readCollection<StoredEntry>(ENTRY_KEY);
      data.items.push({
        id: data.nextId,
        mood,
        content,
        reply,
        createdAt: currentTimestamp(),
      });
      data.nextId += 1;
      this.trim(data);
      await this.writeCollection(ENTRY_KEY, data);
    });
  }

  async deleteEntry(id: number) {
    await this.enqueue(ENTRY_KEY, async () => {
      const data = await this.readCollection<StoredEntry>(ENTRY_KEY);
      data.items = data.items.filter((item) => item.id !== id);
      await this.writeCollection(ENTRY_KEY, data);
    });
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const run = this.tails[key].then(() => task());
    // 内部兜底 catch：失败只作用于当次请求，不污染链尾
    this.tails[key] = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async initializeCollection(key: string) {
    try {
      await this.sendGet(key);
    } catch (error) {
      if (isNoSuchKey(error)) {
        await this.writeCollection(key, { nextId: 1, items: [] });
      } else {
        throw error;
      }
    }
  }

  private async readCollection<T>(key: string): Promise<Collection<T>> {
    const response = await this.sendGet(key);
    const text = await readBody(response.Body);
    const data = JSON.parse(text) as Collection<T>;
    if (
      typeof data.nextId !== "number" ||
      !Array.isArray(data.items)
    ) {
      throw new Error(`Invalid object structure in ${key}`);
    }
    return data;
  }

  private async sendGet(key: string) {
    return this.client.send(
      new GetObjectCommand({
        Bucket: process.env.STORAGE_OBJECT_BUCKET,
        Key: key,
      }),
    );
  }

  private writeCollection<T>(key: string, data: Collection<T>) {
    return this.client.send(
      new PutObjectCommand({
        Bucket: process.env.STORAGE_OBJECT_BUCKET,
        Key: key,
        Body: JSON.stringify(data),
        ContentType: "application/json",
      }),
    );
  }

  private trim<T>(data: Collection<T>) {
    while (data.items.length > MAX_ITEMS) {
      data.items.shift();
    }
  }
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
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  const stream = body as {
    transformToString?: () => Promise<string>;
  };
  if (typeof stream.transformToString === "function") {
    return stream.transformToString();
  }
  throw new Error("Unsupported S3 object body");
}

function isNoSuchKey(error: unknown): boolean {
  const target = error as { name?: string; Code?: string } | null;
  return target?.name === "NoSuchKey" || target?.Code === "NoSuchKey";
}
