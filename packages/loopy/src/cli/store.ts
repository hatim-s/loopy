import { openRunStore, type SqliteRunStore } from "../local/index.js";
import type { CliContext } from "./context.js";

export async function withRunStore<T>(
  context: Pick<CliContext, "home" | "leaseMs">,
  fn: (store: SqliteRunStore) => Promise<T>,
) {
  const store = openRunStore(context.home, { leaseMs: context.leaseMs });

  try {
    return await fn(store);
  } finally {
    store.close();
  }
}
