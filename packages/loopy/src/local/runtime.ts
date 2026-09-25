import type { ExecuteCommand } from "../core/model.js";
import { Runtime } from "../runtime/runtime.js";
import { executeLocalCommand } from "./process.js";
import { defaultHome } from "./registry.js";
import { SqliteRunStore } from "./store.js";

/** Owns the local database. Close only after all executions have settled. */
export function createLocalRuntime(options: { home?: string; executor?: ExecuteCommand } = {}) {
  const store = new SqliteRunStore(options.home ?? defaultHome());
  const runtime = new Runtime({ store, executor: options.executor ?? executeLocalCommand });
  return {
    runtime,
    recoverOwner: (id: string) => store.recoverOwner(id),
    close: () => store.close(),
  };
}
