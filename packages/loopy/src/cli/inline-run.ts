import { setTimeout } from "node:timers/promises";
import type { LocalExecutor, SqliteRunStore } from "../local/index.js";
import type { RateLimits } from "../runtime/index.js";
import { activateLoopy, type Loopy } from "../sdk/host.js";
import { printJson, report } from "./output.js";
import { onTermination } from "./signals.js";
import { requireRun } from "./store.js";

type InlineOptions = {
  executor: LocalExecutor;
  store: SqliteRunStore;
  loopy: Loopy;
  runId: string;
  rateLimits?: RateLimits;
};

export async function inlineRun(options: InlineOptions) {
  const { store, runId } = options;
  const controller = new AbortController();
  const cleanup = onTermination(() => controller.abort());

  try {
    await runActivations(options, controller.signal);
    const result = await requireRun(store, runId);
    printJson(result);

    if (result.status === "suspended" && result.wakeAt === undefined) {
      await reportWaitingHooks(store, runId);
    }

    if (result.status === "failed") {
      process.exitCode = 1;
    }
  } finally {
    cleanup();
  }
}

async function runActivations(options: InlineOptions, signal: AbortSignal) {
  const { store, loopy, runId, executor } = options;
  let run = await requireRun(store, runId);

  while (
    !signal.aborted &&
    (run.status === "queued" || run.status === "suspended" || run.status === "running")
  ) {
    if (run.wakeAt && !(await waitForWake(options, run.wakeAt, signal))) {
      return;
    }

    run = await requireRun(store, runId);

    if (run.status !== "queued" && run.status !== "suspended" && run.status !== "running") {
      return;
    }

    await activateLoopy({ loopy, store, executor, signal, runId, rateLimits: options.rateLimits });
    run = await requireRun(store, runId);

    if (run.status === "suspended" && !run.wakeAt) {
      return;
    }
  }
}

async function waitForWake(options: InlineOptions, wakeAt: string, signal: AbortSignal) {
  if (Date.parse(wakeAt) <= Date.now()) {
    return true;
  }

  report(`Run ${options.runId} wakes at ${wakeAt}. Press Ctrl-C to leave it suspended.`);

  try {
    while (!signal.aborted) {
      const run = await requireRun(options.store, options.runId);

      if (run.wakeAt === undefined || Date.parse(run.wakeAt) <= Date.now()) {
        return true;
      }

      const delay = Math.min(1000, Date.parse(run.wakeAt) - Date.now());
      await setTimeout(Math.max(0, delay), undefined, { signal });
    }
  } catch (cause) {
    if (!signal.aborted) {
      throw cause;
    }
  }

  return !signal.aborted;
}

async function reportWaitingHooks(store: SqliteRunStore, runId: string): Promise<void> {
  const steps = await store.getSteps(runId);

  const waiting = new Set(
    steps.filter((step) => step.status === "waiting").map((step) => step.seq),
  );

  const hooks = (await store.listHooks(runId)).filter((hook) => waiting.has(hook.seq));
  report(
    `Run ${runId} is suspended on hooks: ${hooks.map((hook) => hook.name).join(", ")}. Resolve a hook with loopy hook, then run loopy resume ${runId}.`,
  );
}
