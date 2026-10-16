import type { EngineRun, EngineStep, ExecutionMode, Json, StepKind } from "../core/index.js";
import type { Activation } from "./activation.js";
import type { Clock } from "./clock.js";
import { type Duration, durationMs } from "./duration.js";
import { CommandExitError, type Executor, type ResolvedCommand } from "./executor.js";
import type { StepJournal } from "./journal.js";
import type { Logger } from "./logger.js";
import { type RetryPolicy, resolveRetry } from "./retry.js";
import { runStep, StepFailedError } from "./step-runner.js";
import type { RunStore } from "./store.js";

export type StepOptions = { retry?: RetryPolicy; timeout?: Duration };

type ContextOptions = {
  run: EngineRun;
  store: RunStore;
  executor: Executor;
  token: string;
  cwd: string;
  mode: ExecutionMode;
  clock: Clock;
  activation: Activation;
  journal: StepJournal;
  logger: Logger;
};

function replay(stored: EngineStep): Json {
  if (stored.status === "failed") {
    throw new StepFailedError(stored.key, stored.error);
  }

  if (stored.status === "succeeded") {
    return structuredClone(stored.output);
  }

  throw new Error("Step has no terminal result. Replay only completed steps.");
}

function createPerformer(options: ContextOptions) {
  const { activation, journal, clock } = options;

  async function perform<T extends Json>(
    key: string,
    kind: StepKind,
    input: Json,
    fn: () => T | Promise<T>,
    stepOptions: StepOptions = {},
  ): Promise<T> {
    const retry = resolveRetry(stepOptions.retry);
    const { stored, record } = journal.prepare(key, kind, input, retry.attempts);

    if (stored?.status === "succeeded" || stored?.status === "failed") {
      // SAFETY: The journal key identifies the same typed call and JSON result on every replay.
      return activation.queue(stored.finishOrder, () => replay(stored)) as Promise<T>;
    }

    return runStep(
      {
        record,
        stored,
        activation,
        clock,
        retry,
        store: options.store,
        token: options.token,
        timeoutMs: stepOptions.timeout === undefined ? undefined : durationMs(stepOptions.timeout),
      },
      fn,
    );
  }

  return perform;
}

function createCommand(options: ContextOptions, perform: ReturnType<typeof createPerformer>) {
  return function command(key: string, command: ResolvedCommand, stepOptions: StepOptions = {}) {
    const timeoutMs =
      stepOptions.timeout === undefined ? command.timeoutMs : durationMs(stepOptions.timeout);

    return perform(
      key,
      "command",
      command,
      async () => {
        const result = await options.executor.execute(command, {
          cwd: command.cwd ?? options.cwd,
          mode: options.mode,
          timeoutMs,
        });

        if (result.exitCode !== 0) {
          throw new CommandExitError(result);
        }

        return result;
      },
      { retry: stepOptions.retry },
    );
  };
}

export function createContext(options: ContextOptions) {
  const perform = createPerformer(options);

  return {
    input: structuredClone(options.run.input),
    log: options.logger.log,
    step: <T extends Json>(key: string, fn: () => T | Promise<T>, stepOptions?: StepOptions) =>
      perform(key, "function", null, fn, stepOptions),
    command: createCommand(options, perform),
    sleep: async (duration: Duration): Promise<void> => {
      await perform("sleep", "sleep", durationMs(duration), () => null);
    },
    now: () => perform("now", "clock", null, options.clock.now),
    random: () => perform("random", "random", null, Math.random),
    uuid: () => perform("uuid", "random", null, () => crypto.randomUUID()),
  };
}

export type LoopyContext = ReturnType<typeof createContext>;
