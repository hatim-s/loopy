import type { SandboxExecutionResult } from "@loopy/contract";
import { type AttemptRecord, AuthorityError, type AuthoritySession } from "@loopy/contract";
import { Effect, FiberMap, Result } from "effect";
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
    perform: () => Effect.Effect<SandboxExecutionResult, SandboxFailure>,
  ) {
    return Effect.gen({ self: this }, function* () {
      if (this.has(record.plan.id) || this.options.stopping.stopped) {
        return;
      }

      // The service scope owns reconciliation after the admitting request disconnects.
      yield* FiberMap.run(this.options.active, record.plan.id, this.monitor(record, perform), {
        onlyIfMissing: true,
      });
    });
  }
  private monitor(
    record: Extract<AttemptRecord, { kind: "started" }>,
    perform: () => Effect.Effect<SandboxExecutionResult, SandboxFailure>,
  ) {
    return Effect.gen({ self: this }, function* () {
      const { authority, backend, resultsFor, stopping, session } = this.options;
      const signal = stopping.signal;
      const receipt = { ...record.plan, kind: "started" } as const;
      let observed: SandboxExecutionResult | null = null;
      let reconcile = perform;
      let backoff = 100;

      while (!stopping.stopped) {
        const attempt = yield* Effect.gen(function* () {
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
        }).pipe(Effect.result);

        if (Result.isSuccess(attempt)) {
          return;
        }

        // Never reissue start, even when its acknowledgement was lost.
        reconcile = () => backend.recover(receipt, signal);
        yield* stopping.pause(backoff);
        backoff = Math.min(backoff * 2, 5000);
      }
    });
  }

  drain() {
    return FiberMap.awaitEmpty(this.options.active);
  }
}
