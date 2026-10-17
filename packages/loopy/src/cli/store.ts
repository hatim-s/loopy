import { LoopyService, openRunStore, Registry, type SqliteRunStore } from "../local/index.js";
import { SYSTEM_CLOCK } from "../runtime/index.js";
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

export function runService(context: Pick<CliContext, "home" | "cwd">, store: SqliteRunStore) {
  return new LoopyService({
    home: context.home,
    store,
    registry: (workspace) => new Registry(context.home, workspace || context.cwd),
    clock: SYSTEM_CLOCK,
  });
}
