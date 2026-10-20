import { type ExecutionResult, errorMessage, executionKeyString } from "../core/index.js";
import type { Effect, EngineEvent } from "../engine/index.js";
import type { ActivationOptions } from "./activate.js";
import type { Clock } from "./clock.js";

function completionEvent(
  dispatch: Extract<Effect, { kind: "dispatch" }>,
  result: ExecutionResult,
  at: string,
): EngineEvent {
  const base = { executionKey: dispatch.executionKey, attempt: dispatch.attempt, at };

  return result.kind === "failed"
    ? {
        ...base,
        kind: "execution_failed",
        error: result.error,
        exitCode: result.exitCode,
        logs: result.logs,
      }
    : { ...base, kind: "execution_completed", result };
}

async function execute(
  options: ActivationOptions,
  dispatch: Extract<Effect, { kind: "dispatch" }>,
  signal: AbortSignal,
): Promise<ExecutionResult> {
  const { executor, store, runId } = options;

  while (true) {
    const receipt = await executor.lookup(dispatch.executionKey, dispatch.attempt);

    if (receipt.kind === "finished") {
      return receipt.result;
    }

    if (receipt.kind === "none") {
      return executor.execute(dispatch.executionKey, dispatch.attempt, dispatch.spec, signal);
    }

    // A started receipt is uncertain. Keep reconciling while the executor owns the attempt.
    if (signal.aborted) {
      throw new Error("Execution reconciliation interrupted. Resume the run.");
    }

    if (!(await store.getRun(runId))?.owner) {
      throw new Error("Run lost ownership during reconciliation.");
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForRetry(clock: Clock, at: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cancel = clock.timeout(finish, Math.max(0, Date.parse(at) - clock.now()));

    function finish() {
      signal.removeEventListener("abort", abort);
      resolve();
    }

    function abort() {
      cancel();
      reject(new Error("Retry interrupted. Resume the run."));
    }

    signal.addEventListener("abort", abort, { once: true });
  });
}

type PendingResult =
  | { kind: "event"; id: string; event: EngineEvent }
  | { kind: "error"; id: string; error: Error };

export class ActivationWork {
  private readonly controller = new AbortController();
  private readonly pending = new Map<string, Promise<PendingResult>>();
  readonly signal: AbortSignal;
  private readonly signalled: EngineEvent[] = [];
  private signalWaiter?: (result: PendingResult) => void;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly options: ActivationOptions,
    private readonly clock: Clock,
  ) {
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.controller.signal])
      : this.controller.signal;
    this.unsubscribe = options.store.subscribe((events) => {
      if (
        !events.some(
          (event) =>
            event.runId === options.runId && event.entity === "hook" && event.kind === "resolved",
        )
      ) {
        return;
      }

      const event: EngineEvent = { kind: "retry_due", at: this.timestamp() };

      if (this.signalWaiter) {
        this.signalWaiter({ kind: "event", id: "signal", event });
        this.signalWaiter = undefined;
      } else {
        this.signalled.push(event);
      }
    });
  }

  get inFlight(): ReadonlySet<string> {
    return new Set(this.pending.keys());
  }

  private timestamp() {
    return new Date(this.clock.now()).toISOString();
  }

  private start(id: string, work: () => Promise<EngineEvent>) {
    if (this.pending.has(id)) {
      return;
    }

    this.pending.set(
      id,
      work().then(
        (event): PendingResult => ({ kind: "event", id, event }),
        (cause): PendingResult => ({
          kind: "error",
          id,
          error: cause instanceof Error ? cause : new Error(errorMessage(cause)),
        }),
      ),
    );
  }

  dispatch(effects: Effect[]) {
    for (const effect of effects) {
      if (effect.kind === "dispatch") {
        this.start(`${executionKeyString(effect.executionKey)}/${effect.attempt}`, async () =>
          completionEvent(
            effect,
            await execute(this.options, effect, this.signal),
            this.timestamp(),
          ),
        );
      }

      if (effect.kind === "sample") {
        this.start(`sample/${executionKeyString(effect.executionKey)}`, async () => ({
          kind: "value_sampled",
          executionKey: effect.executionKey,
          value: effect.valueKind === "uuid" ? crypto.randomUUID() : Math.random(),
          at: this.timestamp(),
        }));
      }

      if (effect.kind === "schedule_retry") {
        this.start(`retry/${effect.at}`, async () => {
          await waitForRetry(this.clock, effect.at, this.signal);

          return { kind: "retry_due", at: this.timestamp() };
        });
      }
    }
  }

  async next(): Promise<EngineEvent> {
    const queued = this.signalled.shift();

    if (queued) {
      return queued;
    }

    if (this.pending.size === 0) {
      throw new Error("Active run has no pending execution.");
    }

    const signal = new Promise<PendingResult>((resolve) => {
      this.signalWaiter = resolve;
    });

    const result = await Promise.race([...this.pending.values(), signal]);
    this.signalWaiter = undefined;
    this.pending.delete(result.id);

    if (result.kind === "error") {
      throw result.error;
    }

    return result.event;
  }

  async close() {
    this.unsubscribe();
    this.controller.abort();
    await Promise.allSettled(this.pending.values());
  }
}
