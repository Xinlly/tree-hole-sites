export type StoredEntry = {
  id: string;
  mood: string;
  content: string;
  reply: string;
  createdAt: string;
};

export type StoredMessage = {
  id: string;
  nickname: string;
  content: string;
  createdAt: string;
};

export type ListOptions = {
  afterId?: string | undefined;
  blockKey?: string | undefined;
  index?: number | undefined;
  limit: number;
};

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export interface Store {
  ensureInitialized(): Promise<void>;
  listMessages(options: ListOptions): Promise<Page<StoredMessage>>;
  createMessage(nickname: string, content: string): Promise<void>;
  deleteMessage(id: string): Promise<void>;
  listEntries(options: ListOptions): Promise<Page<StoredEntry>>;
  createEntry(mood: string, content: string, reply: string): Promise<void>;
  deleteEntry(id: string): Promise<void>;
}
