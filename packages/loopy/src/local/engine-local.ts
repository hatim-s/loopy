import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EngineRun } from "../core/index.js";
import { Daemon } from "../runtime/index.js";
import { type Loopy, loopyActivation } from "../sdk/index.js";
import { loadLoopy } from "./bundle.js";
import { LocalExecutor } from "./engine-executor.js";
import { SqliteRunStore } from "./engine-store.js";
import { Loopies } from "./loopies.js";
import { createLocalRuntime } from "./runtime.js";

export function openEngineStore(home: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });

  return new SqliteRunStore(join(home, "engine.sqlite"));
}

export async function loadRunLoopy(home: string, cwd: string, run: EngineRun): Promise<Loopy> {
  const registry = new Loopies(home, cwd);
  const hash = run.bundleHash || registry.get(run.slug).bundleHash;

  return loadLoopy(registry.bundlePath(hash));
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
    executor: new LocalExecutor(),
    cwdFor: () => cwd,
    bundleHashFor: (slug) => registry.get(slug).bundleHash,
    modeFor: () => "sandbox",
    loadWorkflow: async (run) => {
      const loopy = await loadRunLoopy(home, cwd, run);

      return {
        ...loopyActivation(loopy),
        executor: new LocalExecutor(home, loopy.secrets),
        mode: loopy.mode,
      };
    },
  });
}

export async function listLegacyRuns(home: string, slug?: string) {
  if (!existsSync(join(home, "runs.sqlite"))) {
    return [];
  }

  const local = createLocalRuntime({ home });

  try {
    return await local.runtime.listRuns(slug);
  } finally {
    local.close();
  }
}
