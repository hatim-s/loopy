import type { EngineStep, Json, StepBase, StepKind } from "../core/index.js";
import type { Activation } from "./activation.js";
import type { Clock } from "./clock.js";

export class NondeterminismError extends Error {
  constructor(seq: number, expected: string, actual: string) {
    super(
      `Step ${seq} expected key '${expected}' but received '${actual}'. Restore the original step order or start a new run.`,
    );
    this.name = "NondeterminismError";
  }
}

export class StepJournal {
  seq = 0;
  private readonly steps: Map<number, EngineStep>;

  constructor(
    private readonly runId: string,
    steps: EngineStep[],
    private readonly activation: Activation,
    private readonly clock: Clock,
  ) {
    this.steps = new Map(steps.map((step) => [step.seq, step]));
  }

  prepare(key: string, kind: StepKind, input: Json, maxAttempts: number) {
    const seq = ++this.seq;
    const stored = this.steps.get(seq);

    if (stored && stored.key !== key) {
      const error = new NondeterminismError(seq, stored.key, key);
      this.activation.fatal = error;
      throw error;
    }

    const record: StepBase = {
      runId: this.runId,
      seq,
      key,
      kind,
      input,
      attempt: (stored?.attempt ?? 0) + 1,
      maxAttempts: stored?.maxAttempts ?? maxAttempts,
      startedAt: new Date(this.clock.now()).toISOString(),
    };

    return { stored, record };
  }
}
