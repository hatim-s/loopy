import { randomUUID } from "node:crypto";
import type {
  AuthoritySession,
  ExportRecord,
  FinishedAttemptRecord,
  SandboxArtifactRequest,
} from "@loopy/contract/sandbox";
import { Effect, Result, Semaphore } from "effect";
import type { ArtifactReader } from "../artifacts";
import type { SandboxAttemptAuthority } from "../authority";
import type { SandboxFailure } from "../operations";
import { ExportCleanupError, SandboxRequestError } from "../request-error";

function collectPages<Page extends { next: string | null }>(
  fetch: (after: string | null) => Effect.Effect<Page, SandboxFailure>,
) {
  return Effect.gen(function* () {
    const pages: Page[] = [];
    let after: string | null = null;

    do {
      const page: Page = yield* fetch(after);
      pages.push(page);
      after = page.next;
    } while (after !== null);

    return pages;
  });
}

export function recoveryRecords(authority: SandboxAttemptAuthority) {
  return collectPages((after) => authority.recoverable({ after, limit: 200 })).pipe(
    Effect.map((pages) => ({
      attempts: pages.flatMap((page) => page.attempts),
      exports: pages.flatMap((page) => page.exports),
    })),
  );
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
      const record = yield* this.authority.read({ id: guard.attemptId });

      if (!record || record.plan.volume !== guard.volume) {
        return yield* Effect.fail(
          new SandboxRequestError(
            "conflict",
            "Export guard does not match its attempt. Inspect durable state.",
          ),
        );
      }

      yield* this.reader.cleanup(record.plan);
      yield* this.authority.endExport({ session: this.session, token: guard.token });
    });
  }
  reconcile(volume: string) {
    return Effect.gen({ self: this }, function* () {
      const pages = yield* collectPages((after) =>
        this.authority.exportGuards({ after, limit: 200, volume }),
      );

      const exports = pages.flatMap((page) => page.exports);

      if (yield* this.reconcileGuards(exports)) {
        return yield* Effect.fail(
          new ExportCleanupError(
            new Error(`Export guards for volume ${volume} remain unreleased.`),
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
  read(record: FinishedAttemptRecord, request: SandboxArtifactRequest) {
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
            new SandboxRequestError("conflict", `Workspace export was rejected: ${reply.code}.`),
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
