import type {
  CommandResult,
  ExecutionMode,
  Json,
  RunRecord,
  StepKind,
  StepRecord,
} from "../core/index.js";
import type { Activation } from "./activation.js";
import type { Clock } from "./clock.js";
import { type Duration, durationMs } from "./duration.js";
import { CommandExitError, type Executor, type ResolvedCommand } from "./executor.js";
import type { StepJournal } from "./journal.js";
import type { Logger } from "./logger.js";
import { type RetryPolicy, resolveRetry, StepParseError } from "./retry.js";
import { runSleep, runStep, StepFailedError } from "./step-runner.js";
import type { RunStore } from "./store.js";

export type StepOptions = {
  retry?: RetryPolicy;
  timeout?: Duration;
  okExitCodes?: readonly number[];
};

type ContextOptions = {
  run: RunRecord;
  store: RunStore;
  executor: Executor;
  token: string;
  cwd: string;
  mode: ExecutionMode;
  clock: Clock;
  activation: Activation;
  journal: StepJournal;
  logger: Logger;
  signal?: AbortSignal;
  wrap?: ActivationScope;
};

function replay(stored: Extract<StepRecord, { status: "succeeded" | "failed" }>): Json {
  if (stored.status === "failed") {
    throw new StepFailedError(stored.key, stored.error);
  }

  return structuredClone(stored.output);
}

export type StepContext = { log: Logger["log"]; attempt: number };

function createPerformer(options: ContextOptions) {
  const { activation, journal, clock } = options;

  return async function perform<T extends Json>(
    key: string,
    kind: StepKind,
    input: Json,
    fn: (context: StepContext) => T | Promise<T>,
    stepOptions: StepOptions = {},
    run = runStep<T>,
  ): Promise<T> {
    activation.assertOpen();
    const retry = resolveRetry(stepOptions.retry);
    const { stored, record } = journal.prepare(key, kind, input, retry.attempts);

    if (stored?.status === "succeeded" || stored?.status === "failed") {
      // SAFETY: The journal key identifies the same typed call and JSON result on every replay.
      return activation.queue(stored.finishOrder, "memoized", () => replay(stored)) as Promise<T>;
    }

    const runner = {
      record,
      stored,
      activation,
      clock,
      retry,
      store: options.store,
      token: options.token,
      signal: options.signal,
      timeoutMs: stepOptions.timeout === undefined ? undefined : durationMs(stepOptions.timeout),
    };

    const scope = {
      log: options.logger.scope(record.seq, record.attempt),
      attempt: record.attempt,
    };

    return run(runner, () => {
      const invoke = () => fn(scope);

      return options.wrap ? options.wrap.step(invoke, scope) : invoke();
    });
  };
}

async function executeCommand(
  options: ContextOptions,
  command: ResolvedCommand,
  timeoutMs?: number,
  okExitCodes: readonly number[] = [0],
) {
  const result = await options.executor.execute(command, {
    workspace: options.cwd,
    signal: options.signal,
    mode: options.mode,
    timeoutMs,
  });

  if (!okExitCodes.includes(result.exitCode)) {
    throw new CommandExitError(result);
  }

  return result;
}

function parseCommand(result: CommandResult, parse?: (result: CommandResult) => Json): Json {
  if (!parse) {
    return result;
  }

  try {
    return parse(result);
  } catch (cause) {
    if (result.exitCode !== 0) {
      throw new CommandExitError(result);
    }

    throw new StepParseError(cause);
  }
}

function createCommand(options: ContextOptions, perform: ReturnType<typeof createPerformer>) {
  function command(
    key: string,
    command: ResolvedCommand,
    stepOptions?: StepOptions,
  ): Promise<CommandResult>;
  function command<T extends Json>(
    key: string,
    command: ResolvedCommand,
    stepOptions: StepOptions | undefined,
    parse: (result: CommandResult) => T,
  ): Promise<T>;
  function command(
    key: string,
    command: ResolvedCommand,
    stepOptions: StepOptions = {},
    parse?: (result: CommandResult) => Json,
  ): Promise<Json> {
    const timeoutMs =
      stepOptions.timeout === undefined ? command.timeoutMs : durationMs(stepOptions.timeout);

    return perform(
      key,
      "command",
      command,
      async () => {
        const result = await executeCommand(options, command, timeoutMs, stepOptions.okExitCodes);

        return parseCommand(result, parse);
      },
      { retry: stepOptions.retry },
    );
  }

  return command;
}

export function createContext(options: ContextOptions) {
  const perform = createPerformer(options);

  return {
    input: structuredClone(options.run.input),
    log: options.logger.log,
    step: <T extends Json>(
      key: string,
      fn: (context: StepContext) => T | Promise<T>,
      stepOptions?: StepOptions,
    ) => perform(key, "function", null, fn, stepOptions),
    command: createCommand(options, perform),
    sleep: async (duration: Duration): Promise<void> => {
      const milliseconds = durationMs(duration);
      await perform(
        "sleep",
        "sleep",
        milliseconds,
        () => null,
        {},
        (runner) => runSleep(runner, milliseconds),
      );
    },
    now: () => perform("now", "clock", null, options.clock.now),
    random: () => perform("random", "random", null, Math.random),
    uuid: () => perform("uuid", "random", null, () => crypto.randomUUID()),
  };
}

export type WorkflowContext = ReturnType<typeof createContext>;

export type ActivationScope = {
  workflow<T>(fn: () => T, context: WorkflowContext, fail: (error: Error) => void): T;
  step<T>(fn: () => T, context: StepContext): T;
};
