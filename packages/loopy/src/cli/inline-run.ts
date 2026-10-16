import { setTimeout } from "node:timers/promises";
import { LocalExecutor, type SqliteRunStore } from "../local/index.js";
import { activateLoopy, type Loopy } from "../sdk/index.js";
import { requireRun } from "./engine-store.js";
import { printJson, report } from "./output.js";

type InlineOptions = {
  home: string;
  cwd: string;
  store: SqliteRunStore;
  loopy: Loopy;
  runId: string;
};

export async function inlineRun(options: InlineOptions) {
  const { home, cwd, store, loopy, runId } = options;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);

  try {
    let run = await requireRun(store, runId);

    while (!controller.signal.aborted && (run.status === "queued" || run.status === "suspended")) {
      if (run.wakeAt && !(await waitForWake(runId, run.wakeAt, controller.signal))) {
        break;
      }

      await activateLoopy({
        loopy,
        store,
        executor: new LocalExecutor(home, loopy.secrets),
        runId,
        cwd,
      });
      run = await requireRun(store, runId);

      if (run.status === "suspended" && !run.wakeAt) {
        break;
      }
    }

    const result = await requireRun(store, runId);
    printJson(result);

    if (result.status === "failed") {
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

async function waitForWake(runId: string, wakeAt: string, signal: AbortSignal) {
  if (Date.parse(wakeAt) <= Date.now()) {
    return true;
  }

  report(`Run ${runId} wakes at ${wakeAt}. Press Ctrl-C to leave it suspended.`);

  try {
    while (!signal.aborted && Date.parse(wakeAt) > Date.now()) {
      const delay = Math.min(2_147_483_647, Date.parse(wakeAt) - Date.now());
      await setTimeout(Math.max(0, delay), undefined, { signal });
    }
  } catch (cause) {
    if (!signal.aborted) {
      throw cause;
    }
  }

  return !signal.aborted;
}
