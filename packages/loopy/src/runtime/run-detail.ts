import type { RunDetail, RunRecord } from "../core/index.js";
import type { RunStore } from "./store.js";

export async function runDetail(store: RunStore, run: RunRecord): Promise<RunDetail> {
  const [steps, logs] = await Promise.all([store.getSteps(run.id), store.getLogs(run.id)]);

  return { run, steps, logs };
}
