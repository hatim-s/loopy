import { type ExecutionMode, errorMessage, type Json, type RunOutcome } from "../core/index.js";
import { Activation } from "./activation.js";
import { type Clock, SYSTEM_CLOCK } from "./clock.js";
import { createContext, type LoopyContext } from "./context.js";
import type { Executor } from "./executor.js";
import { StepJournal } from "./journal.js";
import { assertJson } from "./json.js";
import { Logger } from "./logger.js";
import type { RunStore } from "./store.js";

export type ActivationOptions = {
  runId: string;
  store: RunStore;
  executor: Executor;
  workflow: (context: LoopyContext) => Promise<Json>;
  cwd: string;
  mode: ExecutionMode;
  clock?: Clock;
};

export type ActivationOutcome = RunOutcome | { status: "suspended"; wakeAt: string };

async function settle(
  activation: Activation,
  context: LoopyContext,
  workflow: ActivationOptions["workflow"],
): Promise<ActivationOutcome> {
  let outcome: RunOutcome | undefined;
  void Promise.resolve()
    .then(() => workflow(context))
    .then((output) => {
      assertJson(output, "Workflow output");
      outcome = { status: "succeeded", output };
    })
    .catch((cause: unknown) => {
      outcome = { status: "failed", error: errorMessage(cause) };
    });

  while (true) {
    await activation.tick();

    if (activation.fatal) {
      return { status: "failed", error: errorMessage(activation.fatal) };
    }

    if (outcome) {
      return outcome;
    }

    if (activation.deliverReplay()) {
      continue;
    }

    if (activation.running === 0 && activation.blocked > 0 && activation.wakeAt !== undefined) {
      return { status: "suspended", wakeAt: activation.wakeAt };
    }
  }
}

async function persist(
  store: RunStore,
  runId: string,
  token: string,
  outcome: ActivationOutcome,
): Promise<ActivationOutcome> {
  try {
    if (outcome.status === "suspended") {
      await store.suspend(runId, token, outcome.wakeAt);
    } else {
      await store.finishRun(runId, token, outcome);
    }

    return outcome;
  } catch (cause) {
    const failure: RunOutcome = { status: "failed", error: errorMessage(cause) };
    await store.finishRun(runId, token, failure);

    return failure;
  }
}

export async function activate(options: ActivationOptions): Promise<ActivationOutcome> {
  const { store, runId } = options;
  const token = crypto.randomUUID();
  const run = await store.claim(runId, token);

  try {
    const clock = options.clock ?? SYSTEM_CLOCK;
    const steps = await store.getSteps(runId);
    const activation = new Activation(steps);
    const journal = new StepJournal(runId, steps, activation, clock);

    const logger = new Logger({
      runId,
      token,
      store,
      clock,
      journal,
      activation,
      logs: await store.getLogs(runId),
    });

    const context = createContext({ ...options, run, token, clock, activation, journal, logger });
    let outcome = await settle(activation, context, options.workflow);

    try {
      await logger.flush();
    } catch (cause) {
      outcome = { status: "failed", error: errorMessage(cause) };
    }

    return await persist(store, runId, token, outcome);
  } finally {
    await store.release(runId, token);
  }
}
