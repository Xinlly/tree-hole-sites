import { getStore } from "./store/index.ts";
import type { StoredEntry, StoredMessage } from "./store/types.ts";

export type { StoredEntry, StoredMessage };

export async function ensureTables() {
  await getStore().ensureInitialized();
}

export async function listMessages() {
  return getStore().listMessages();
}

export async function createMessage(nickname: string, content: string) {
  await getStore().createMessage(nickname, content);
}

export async function deleteMessage(id: number) {
  await getStore().deleteMessage(id);
}

export async function listEntries() {
  return getStore().listEntries();
}

export async function createEntry(mood: string, content: string, reply: string) {
  await getStore().createEntry(mood, content, reply);
}

export async function deleteEntry(id: number) {
  await getStore().deleteEntry(id);
}

export function normalizeNickname(value: string | undefined) {
  const nickname = value?.trim();
  return nickname ? nickname.slice(0, 24) : "匿名";
}

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}
