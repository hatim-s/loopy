import { openEngineStore, type SqliteRunStore } from "../local/index.js";

export async function withEngineStore<T>(home: string, fn: (store: SqliteRunStore) => Promise<T>) {
  const store = openEngineStore(home);

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
