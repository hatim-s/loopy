import type { EngineRun, ExecutionMode, Json } from "../core/index.js";
import { errorMessage } from "../core/index.js";
import { Context, type EngineClock, type Executor, SYSTEM_CLOCK } from "./context.js";
import { assertJson } from "./json.js";
import type { RunStore } from "./store.js";

export type ActivationOptions = {
  run: EngineRun;
  store: RunStore;
  executor: Executor;
  workflow: (context: Context) => Promise<Json>;
  cwd: string;
  mode: ExecutionMode;
  clock?: EngineClock;
};

type Outcome = { status: "succeeded"; output: Json } | { status: "failed"; error: string };

export async function activate(options: ActivationOptions): Promise<EngineRun> {
  const { store, executor, workflow } = options;
  const token = crypto.randomUUID();
  const run = await store.claim(options.run.id, token);
  const clock = options.clock ?? SYSTEM_CLOCK;

  try {
    const context = new Context({
      ...options,
      run,
      executor,
      token,
      clock,
      steps: await store.getSteps(run.id),
      logSequences: (await store.getLogs(run.id)).map((log) => log.seq),
    });

    let outcome: Outcome | undefined;

    const result = Promise.resolve()
      .then(() => workflow(context))
      .then((output) => {
        assertJson(output, "Workflow output");
        outcome = { status: "succeeded", output };
      })
      .catch((cause: unknown) => {
        outcome = { status: "failed", error: errorMessage(cause) };
      });

    while (!outcome) {
      const changed = context.changed();

      if (context.running === 0 && context.blocked > 0) {
        await clock.tick();

        if (context.running === 0 && !outcome) {
          break;
        }

        continue;
      }

      await Promise.race([result, changed]);
    }

    await context.flushLogs();

    if (!outcome) {
      await store.suspend(run.id, token, context.wakeAt);
    } else if (outcome.status === "failed") {
      await store.finishRun(run.id, token, "failed", undefined, outcome.error);
    } else {
      await store.finishRun(run.id, token, "succeeded", outcome.output);
    }
  } finally {
    await store.release(run.id, token);
  }

  const updated = await store.getRun(run.id);

  if (!updated) {
    throw new Error(
      `Run '${run.id}' disappeared. Restore its persisted record before activating again.`,
    );
  }

  return updated;
}
