import { randomUUID } from "node:crypto";
import type { AuthorityOutput, SandboxArtifactRequest } from "@loopy/contract";
import {
  type AttemptRecord,
  type AuthoritySession,
  artifactHelperName,
  type ExportRecord,
} from "@loopy/contract";
import { Effect, Result, Semaphore } from "effect";
import { ArtifactError, ExportCleanupError } from "../artifact-error";
import type { ArtifactReader } from "../artifacts";
import type { SandboxAttemptAuthority } from "../operations";

export function recoveryRecords(authority: SandboxAttemptAuthority) {
  return Effect.gen(function* () {
    const attempts: Extract<AttemptRecord, { kind: "started" }>[] = [];
    const exports: ExportRecord[] = [];
    let after: string | null = null;

    do {
      const page: AuthorityOutput<"recoverable"> = yield* authority.recoverable({
        after,
        limit: 200,
      });

      attempts.push(...page.attempts);
      exports.push(...page.exports);
      after = page.next;
    } while (after !== null);

    return { attempts, exports };
  });
}

export class AttemptExports {
  private readonly live = new Set<string>();
  private readonly reconciliation = Semaphore.makeUnsafe(1);
  constructor(
    private readonly authority: SandboxAttemptAuthority,
    private readonly reader: ArtifactReader,
    private readonly session: AuthoritySession,
  ) {}
  private release(guard: ExportRecord) {
    return Effect.gen({ self: this }, function* () {
      const record = yield* this.authority.read(guard.attemptId);

      if (
        !record ||
        record.plan.volume !== guard.volume ||
        guard.helper !== artifactHelperName(record.plan.id)
      ) {
        return yield* Effect.fail(
          new ArtifactError(
            "conflict",
            "Export guard does not match its attempt. Inspect durable state.",
          ),
        );
      }

      yield* this.reader.cleanup(record.plan, guard.helper);
      yield* this.authority.endExport({ session: this.session, token: guard.token });
    });
  }
  reconcile(volume: string) {
    return Effect.gen({ self: this }, function* () {
      const exports: ExportRecord[] = [];
      let after: string | null = null;

      do {
        const page: AuthorityOutput<"exportGuards"> = yield* this.authority.exportGuards({
          after,
          limit: 200,
          volume,
        });

        exports.push(...page.exports);
        after = page.next;
      } while (after !== null);

      if (yield* this.reconcileGuards(exports)) {
        return yield* Effect.fail(
          new ArtifactError(
            "conflict",
            "Workspace export cleanup is unresolved. Retry after reconciliation.",
          ),
        );
      }
    });
  }
  reconcileGuards(exports: ExportRecord[]) {
    return this.reconciliation.withPermit(
      Effect.gen({ self: this }, function* () {
        let blocked = false;

        for (const guard of exports) {
          if (this.live.has(guard.token)) {
            blocked = true;
            continue;
          }

          const released = yield* this.release(guard).pipe(Effect.result);

          if (Result.isFailure(released)) {
            blocked = true;
          }
        }

        return blocked;
      }),
    );
  }
  read(record: Extract<AttemptRecord, { kind: "finished" }>, request: SandboxArtifactRequest) {
    return Effect.gen({ self: this }, function* () {
      yield* this.reconcile(record.plan.volume);
      const token = randomUUID();
      this.live.add(token);

      return yield* Effect.gen({ self: this }, function* () {
        const reply = yield* this.authority.beginExport({
          session: this.session,
          attemptId: record.plan.id,
          token,
        });

        if (reply.kind === "rejected") {
          return yield* Effect.fail(
            new ArtifactError("conflict", `Workspace export was rejected: ${reply.code}.`),
          );
        }

        return yield* Effect.acquireUseRelease(
          Effect.succeed(reply.record),
          () => this.reader.read(record.plan, request.path),
          (guard) =>
            this.release(guard).pipe(Effect.mapError((cause) => new ExportCleanupError(cause))),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.live.delete(token);
          }),
        ),
      );
    });
  }
}
