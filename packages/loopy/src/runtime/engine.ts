import { type ExecutionMode, errorMessage, type Json, type RunOutcome } from "../core/index.js";
import { Activation } from "./activation.js";
import { type Clock, SYSTEM_CLOCK } from "./clock.js";
import { type ActivationScope, createContext, type WorkflowContext } from "./context.js";
import type { Executor } from "./executor.js";
import { withHeartbeat } from "./heartbeat.js";
import { StepJournal } from "./journal.js";
import { assertJson } from "./json.js";
import { Logger } from "./logger.js";
import type { RateLimits } from "./rate-limit.js";
import type { RunStore } from "./store.js";

export type ActivationOptions = {
  rateLimits?: RateLimits;
  runId: string;
  store: RunStore;
  executor: Executor;
  workflow: (context: WorkflowContext) => Promise<Json>;
  cwd: string;
  mode: ExecutionMode;
  clock?: Clock;
  signal?: AbortSignal;
  wrap?: ActivationScope;
};

type ActivationOutcome = RunOutcome | { status: "suspended"; wakeAt: string };

function startWorkflow(
  activation: Activation,
  context: WorkflowContext,
  workflow: ActivationOptions["workflow"],
  wrap?: ActivationOptions["wrap"],
) {
  void Promise.resolve()
    .then(() => {
      const invoke = () => workflow(context);

      return wrap ? wrap.workflow(invoke, context, (error) => activation.fail(error)) : invoke();
    })
    .then((output) => {
      assertJson(output, "Workflow output");
      activation.complete({ status: "succeeded", output });
    })
    .catch((cause: unknown) => {
      activation.complete({ status: "failed", error: errorMessage(cause) });
    });
}

function settledOutcome(
  activation: Activation,
  options: ActivationOptions,
): ActivationOutcome | undefined {
  if (activation.running !== 0) {
    return undefined;
  }

  if (options.signal?.aborted) {
    activation.close();

    return {
      status: "suspended",
      wakeAt: new Date((options.clock ?? SYSTEM_CLOCK).now()).toISOString(),
    };
  }

  if (!activation.closed) {
    return undefined;
  }

  if (activation.fatal) {
    return { status: "failed", error: errorMessage(activation.fatal) };
  }

  return activation.outcome;
}

async function drainActivation(
  activation: Activation,
  context: WorkflowContext,
  options: ActivationOptions,
): Promise<ActivationOutcome> {
  startWorkflow(activation, context, options.workflow, options.wrap);

  while (true) {
    await activation.tick();
    const outcome = settledOutcome(activation, options);

    if (outcome) {
      return outcome;
    }

    if (activation.deliver()) {
      continue;
    }

    if (
      !activation.closed &&
      activation.running === 0 &&
      activation.blocked > 0 &&
      activation.wakeAt !== undefined
    ) {
      activation.close();

      return { status: "suspended", wakeAt: activation.wakeAt };
    }

    await activation.changed;
  }
}

async function settle(
  activation: Activation,
  context: WorkflowContext,
  options: ActivationOptions,
) {
  const interrupt = () => activation.close();
  options.signal?.addEventListener("abort", interrupt, { once: true });

  try {
    return await drainActivation(activation, context, options);
  } finally {
    options.signal?.removeEventListener("abort", interrupt);
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

async function executeActivation(
  options: ActivationOptions,
  run: Awaited<ReturnType<RunStore["claim"]>>,
  token: string,
): Promise<ActivationOutcome> {
  const { store, runId } = options;
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
  let outcome = await settle(activation, context, { ...options, clock });

  try {
    await logger.flush();
  } catch (cause) {
    outcome = { status: "failed", error: errorMessage(cause) };
  }

  return persist(store, runId, token, outcome);
}

async function release(
  store: RunStore,
  runId: string,
  token: string,
  failure?: Error,
): Promise<void> {
  try {
    await store.release(runId, token);
  } catch (cause) {
    if (!failure) {
      throw cause;
    }

    failure.cause = cause;
    throw failure;
  }
}

export async function activate(options: ActivationOptions): Promise<ActivationOutcome> {
  const { store, runId } = options;
  const token = crypto.randomUUID();
  const run = await store.claim(runId, token);
  let failure: Error | undefined;

  try {
    const outcome = await withHeartbeat(store, runId, token, () =>
      executeActivation(options, run, token),
    );

    if (outcome.status === "failed") {
      failure = new Error(outcome.error);
    }

    return outcome;
  } catch (cause) {
    failure = cause instanceof Error ? cause : new Error(errorMessage(cause));
    throw failure;
  } finally {
    await release(store, runId, token, failure);
  }
}
