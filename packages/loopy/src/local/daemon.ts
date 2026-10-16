import type { RunRecord } from "../core/index.js";
import { Daemon } from "../runtime/index.js";
import { loopyActivation } from "../sdk/host.js";
import { loadRunLoopy } from "./bundle.js";
import { LocalExecutor } from "./executor.js";
import { Registry } from "./registry.js";
import type { SqliteRunStore } from "./store.js";

export function localDaemon(options: {
  home: string;
  cwd: string;
  store: SqliteRunStore;
  concurrency?: number;
  onError?: (error: Error, run?: RunRecord) => void;
}) {
  const { home } = options;

  return new Daemon({
    ...options,
    bundleHashFor: (schedule) =>
      new Registry(home, schedule.workspace).get(schedule.slug).bundleHash,
    prepare: async (run) => {
      const loopy = await loadRunLoopy(home, run);

      return {
        ...loopyActivation(loopy),
        executor: new LocalExecutor({ home, secrets: loopy.secrets }),
        mode: loopy.mode,
        cwd: run.workspace,
      };
    },
  });
}
