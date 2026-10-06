import type { ExecuteCommand } from "../core/model.js";
import { Runtime } from "../runtime/runtime.js";
import { defaultHome } from "./registry.js";
import { secretExecutor } from "./secret-executor.js";
import { SqliteRunStore } from "./store.js";

/** Owns the local database. Close only after all executions have settled. */
export function createLocalRuntime(options: { home?: string; executor?: ExecuteCommand } = {}) {
  const home = options.home ?? defaultHome();
  const store = new SqliteRunStore(home);
  const runtime = new Runtime({ store, executor: secretExecutor(home, store, options.executor) });
  return {
    runtime,
    recoverOwner: (id: string) => store.recoverOwner(id),
    close: () => store.close(),
  };
}
