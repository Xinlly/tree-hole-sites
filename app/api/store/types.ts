export type StoredEntry = {
  id: number;
  mood: string;
  content: string;
  reply: string;
  createdAt: string;
};

export type StoredMessage = {
  id: number;
  nickname: string;
  content: string;
  createdAt: string;
};

export interface Store {
  ensureInitialized(): Promise<void>;
  listMessages(): Promise<StoredMessage[]>;
  createMessage(nickname: string, content: string): Promise<void>;
  deleteMessage(id: number): Promise<void>;
  listEntries(): Promise<StoredEntry[]>;
  createEntry(mood: string, content: string, reply: string): Promise<void>;
  deleteEntry(id: number): Promise<void>;
}
