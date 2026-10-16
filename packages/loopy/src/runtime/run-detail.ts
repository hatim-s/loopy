import type { EngineRun, EngineRunDetail } from "../core/index.js";
import type { RunStore } from "./store.js";

export async function engineRunDetail(store: RunStore, run: EngineRun): Promise<EngineRunDetail> {
  const [steps, logs] = await Promise.all([store.getSteps(run.id), store.getLogs(run.id)]);

  return { run, steps, logs };
}
