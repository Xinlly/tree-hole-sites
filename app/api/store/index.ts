import { ObjectStore } from "./object-store.ts";
import { SqlStore } from "./sql-store.ts";
import type { Store } from "./types.ts";

let store: Store | undefined;

export function getStore(): Store {
  if (store) {
    return store;
  }
  const type = process.env.STORAGE_TYPE ?? "sql";
  if (type === "sql") {
    store = new SqlStore();
    return store;
  }
  if (type === "object") {
    const missing = [
      "STORAGE_OBJECT_ENDPOINT",
      "STORAGE_OBJECT_REGION",
      "STORAGE_OBJECT_BUCKET",
      "STORAGE_OBJECT_ACCESS_KEY_ID",
      "STORAGE_OBJECT_SECRET_ACCESS_KEY",
    ].filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(
        `Missing object storage config: ${missing.join(", ")}`,
      );
    }
    store = new ObjectStore();
    return store;
  }
  throw new Error(`Invalid STORAGE_TYPE "${type}" (expected sql|object)`);
}
