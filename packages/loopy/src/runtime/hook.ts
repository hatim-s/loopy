import type { HookRecord, Json, WaitingHookStep } from "../core/index.js";
import { type Duration, durationMs } from "./duration.js";
import { failStep, type Runner, succeed } from "./step-runner.js";

export async function runHook(options: Runner, name: string, timeout?: Duration): Promise<Json> {
  const { stored, activation, clock } = options;
  const wakeAt = hookWakeAt(options, timeout);
  activation.start();

  try {
    const record = stored ?? (await createHook(options, name, wakeAt));

    // Preserve hook identity on completion without carrying waiting-only fields.
    const runner = {
      ...options,
      record: {
        ...options.record,
        input: record.input,
        attempt: record.attempt,
        maxAttempts: record.maxAttempts,
        startedAt: record.startedAt,
      },
    };

    let hook = await readHook(runner);

    if (
      hook.resolvedAt === undefined &&
      (wakeAt === undefined || Date.parse(wakeAt) > clock.now())
    ) {
      activation.end();
      hook = await activation.waitForHook(record.seq, wakeAt);
    }

    return await completeHook(runner, hook);
  } finally {
    activation.end();
  }
}

function hookWakeAt(options: Runner, timeout?: Duration): string | undefined {
  if (options.stored?.status === "waiting") {
    return options.stored.wakeAt;
  }

  return timeout === undefined
    ? undefined
    : new Date(options.clock.now() + durationMs(timeout)).toISOString();
}

async function readHook(options: Runner): Promise<HookRecord> {
  const [hook] = await options.store.listPendingHooks(options.record.runId, [options.record.seq]);

  if (!hook) {
    throw new Error("Waiting hook is missing. Start a new run to create its hook.");
  }

  return hook;
}

async function completeHook(options: Runner, hook: HookRecord): Promise<Json> {
  if (hook.payload !== undefined) {
    return succeed(options, hook.payload);
  }

  const { store, record, token } = options;

  const deadline = await store.expireHook(record.runId, token, record.seq);

  if (deadline !== undefined) {
    return failStep(
      options,
      new Error(
        `Hook '${hook.name}' timed out at ${deadline}. Resolve the hook before its deadline in a new run.`,
      ),
    );
  }

  const resolved = await readHook(options);

  if (resolved.payload !== undefined) {
    return succeed(options, resolved.payload);
  }

  throw new Error("Hook could not expire. Resume the run to check its resolution.");
}

async function createHook(
  options: Runner,
  name: string,
  wakeAt?: string,
): Promise<WaitingHookStep> {
  const step: WaitingHookStep = {
    ...options.record,
    kind: "hook",
    attempt: 1,
    maxAttempts: 1,
    status: "waiting",
    input: { name, token: crypto.randomUUID() },
    wakeAt,
  };

  try {
    await options.store.createHook(step.runId, options.token, step);

    return step;
  } catch (cause) {
    options.activation.fail(cause instanceof Error ? cause : new Error(String(cause)));
    throw cause;
  }
}
