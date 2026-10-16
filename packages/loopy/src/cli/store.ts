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

export async function requireRun(store: SqliteRunStore, id: string) {
  const run = await store.getRun(id);

  if (!run) {
    throw new Error(`No run '${id}'. Use loopy runs to list run ids.`);
  }

  return run;
}
