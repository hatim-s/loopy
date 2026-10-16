import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EngineRun } from "../core/index.js";
import { Daemon } from "../runtime/index.js";
import { type Loopy, loopyActivation } from "../sdk/host.js";
import { loadLoopy } from "./bundle.js";
import { LocalExecutor } from "./engine-executor.js";
import { SqliteRunStore } from "./engine-store.js";
import { Loopies } from "./loopies.js";

export function openEngineStore(home: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });

  return new SqliteRunStore(join(home, "engine.sqlite"));
}

export async function loadRunLoopy(home: string, run: EngineRun): Promise<Loopy> {
  const registry = new Loopies(home, run.workspace);

  return loadLoopy(registry.bundlePath(run.bundleHash));
}

export function localDaemon(options: {
  home: string;
  cwd: string;
  store: SqliteRunStore;
  concurrency?: number;
  onError?: (error: Error, run?: EngineRun) => void;
}) {
  const { home, cwd } = options;
  const registry = new Loopies(home, cwd);

  return new Daemon({
    ...options,
    workspace: cwd,
    bundleHashFor: (slug) => registry.get(slug).bundleHash,
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
