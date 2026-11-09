import type { ExecutionResult } from "@loopy/contract";
import { type AttemptRecord, AuthorityError, type AuthoritySession } from "@loopy/contract";
import { Effect, FiberMap } from "effect";
import type { AttemptBackend } from "../docker";
import type { ResultsFor, SandboxAttemptAuthority, SandboxFailure } from "../operations";
import { boundedResult } from "../result";
import type { Stopping } from "../stopping";

export class AttemptMonitors {
  constructor(
    private readonly options: {
      authority: SandboxAttemptAuthority;
      resultsFor: ResultsFor;
      backend: AttemptBackend;
      session: AuthoritySession;
      stopping: Stopping;
      active: FiberMap.FiberMap<string, void, never>;
    },
  ) {}
  has(id: string) {
    return FiberMap.hasUnsafe(this.options.active, id);
  }
  launch(
    record: Extract<AttemptRecord, { kind: "started" }>,
    perform: () => Effect.Effect<ExecutionResult, SandboxFailure>,
  ) {
    return Effect.gen({ self: this }, function* () {
      if (this.options.stopping.stopped) {
        return;
      }

      yield* FiberMap.run(this.options.active, record.plan.id, this.monitor(record, perform), {
        onlyIfMissing: true,
      });
    });
  }
  private monitor(
    record: Extract<AttemptRecord, { kind: "started" }>,
    perform: () => Effect.Effect<ExecutionResult, SandboxFailure>,
  ) {
    const { authority, backend, resultsFor, stopping, session } = this.options;
    let observed: ExecutionResult | null = null;
    let reconcile = perform;

    const publish = Effect.gen(function* () {
      observed ??= boundedResult(yield* reconcile());

      if (stopping.stopped) {
        return;
      }

      const result = yield* resultsFor(record.plan.workspace).put(observed);

      if (stopping.stopped) {
        return;
      }

      const completed = yield* authority.complete({
        session,
        id: record.plan.id,
        requestHash: record.plan.requestHash,
        result,
      });

      if (completed.kind === "rejected") {
        return yield* Effect.fail(new AuthorityError(completed.code));
      }
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          // Never reissue start, even when its acknowledgement was lost.
          reconcile = () => backend.recover(record.plan, stopping.signal);
        }),
      ),
    );

    // Stopping leaves the receipt started for the next process to reconcile.
    return stopping.retry(publish).pipe(Effect.catch(() => Effect.void));
  }

  drain() {
    return FiberMap.awaitEmpty(this.options.active);
  }
}
