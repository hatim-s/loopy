import { rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AttemptRecord,
  AuthorityError,
  type AuthorityInput,
  type AuthorityOutput,
  type AuthoritySession,
  admitTransition,
  beginExportTransition,
  completeTransition,
  type ExportRecord,
  resultBytes,
  resultRef,
  sameSession,
} from "@loopy/contract/sandbox";
import { syncDirectory, writeFileAtomically } from "@loopy/runtime/os";
import { Effect, Semaphore } from "effect";
import type { SandboxAttemptAuthority } from "../authority";
import { checked, type SandboxOperationError } from "../operations";
import { FilesystemJournal } from "./journal";
import { FilesystemResults } from "./results";

// Retained legacy receipts embed their result; see the README exit condition.
function inlineRef(record: AttemptRecord | null) {
  if (record?.kind !== "finished" || record.result.kind !== "inline") {
    return Effect.succeed(null);
  }

  const bytes = resultBytes(record.result.value);

  return bytes === null ? Effect.succeed(null) : Effect.promise(() => resultRef(bytes));
}

function persist(path: string, record: AttemptRecord | ExportRecord) {
  return checked("filesystem-authority", () =>
    writeFileAtomically(path, JSON.stringify(record), 0o600),
  );
}

function byteOrder(left: string, right: string) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export class FilesystemAuthority implements SandboxAttemptAuthority {
  private session: AuthoritySession | null = null;
  private closed = false;
  private readonly mutex = Semaphore.makeUnsafe(1);
  private readonly journal: FilesystemJournal;
  constructor(private readonly root: string) {
    this.journal = new FilesystemJournal(root);
  }

  private serial<T>(operation: () => Effect.Effect<T, SandboxOperationError | AuthorityError>) {
    return this.mutex
      .withPermit(
        Effect.suspend(() =>
          this.closed ? Effect.fail(new AuthorityError("stale_session")) : operation(),
        ),
      )
      .pipe(Effect.uninterruptible);
  }

  // The OS lock supplies exclusion. This adapter makes no persistent epoch claim.
  status() {
    return Effect.gen({ self: this }, function* () {
      return { epoch: this.session ? 1 : 0 };
    });
  }

  openSession(input: AuthorityInput<"openSession">) {
    return this.serial(() => {
      return Effect.gen({ self: this }, function* () {
        if (this.session?.nonce === input.nonce) {
          return this.session;
        }

        if (input.expectedEpoch !== (this.session ? 1 : 0)) {
          return yield* Effect.fail(new AuthorityError("stale_session"));
        }

        this.session = { epoch: 1, nonce: input.nonce };

        return this.session;
      });
    });
  }

  read(input: AuthorityInput<"read">) {
    return this.journal.read(input.id);
  }

  admit(input: AuthorityInput<"admit">) {
    return this.serial(() =>
      Effect.gen({ self: this }, function* () {
        const decision = admitTransition(input, {
          current: this.session,
          validPlan: yield* this.journal.validPlan(input.plan),
          existing: yield* this.journal.read(input.plan.id),
          workspaceBusy: (yield* this.journal.guards()).some(
            (guard) => guard.volume === input.plan.volume,
          ),
        });

        if (decision.kind === "created") {
          yield* persist(this.journal.receiptPath(input.plan.id), decision.record);
        }

        return decision;
      }),
    );
  }

  complete(
    input: AuthorityInput<"complete">,
  ): Effect.Effect<AuthorityOutput<"complete">, SandboxOperationError | AuthorityError> {
    return this.serial(() =>
      Effect.gen({ self: this }, function* () {
        const existing = yield* this.journal.read(input.id);

        const decision = completeTransition(input, {
          current: this.session,
          existing,
          inlineRef: yield* inlineRef(existing),
        });

        if (decision.kind !== "publish") {
          return decision;
        }

        yield* new FilesystemResults(this.root, decision.record.plan.workspace).get(input.result);
        yield* persist(this.journal.receiptPath(input.id), decision.record);

        return { kind: "finished", record: decision.record };
      }),
    );
  }

  beginExport(
    input: AuthorityInput<"beginExport">,
  ): Effect.Effect<AuthorityOutput<"beginExport">, SandboxOperationError | AuthorityError> {
    return this.serial(() =>
      Effect.gen({ self: this }, function* () {
        const guards = yield* this.journal.guards();
        const released = yield* this.journal.released(input.token);
        const token = released ?? guards.find((guard) => guard.token === input.token);

        const started = (yield* this.journal.records()).filter(
          (record) => record.kind === "started",
        );

        const decision = beginExportTransition(input, {
          current: this.session,
          token: token ? { record: token, active: released === null } : null,
          attempt: yield* this.journal.read(input.attemptId),
          workspaceBusy: (volume) =>
            guards.some((guard) => guard.volume === volume) ||
            started.some((record) => record.plan.volume === volume),
        });

        if (decision.kind !== "create") {
          return decision;
        }

        yield* persist(this.journal.guardPath(input.attemptId), decision.record);

        return { kind: "granted", record: decision.record };
      }),
    );
  }

  endExport(input: AuthorityInput<"endExport">) {
    return this.serial(() => {
      return Effect.gen({ self: this }, function* () {
        if (!sameSession(input.session, this.session)) {
          return yield* Effect.fail(new AuthorityError("stale_session"));
        }

        const guard = (yield* this.journal.guards()).find((record) => record.token === input.token);

        if (guard) {
          yield* persist(this.journal.releasedPath(guard.token), guard);
          const path = this.journal.guardPath(guard.attemptId);
          yield* checked("filesystem-authority", () => {
            rmSync(path, { force: true });
            syncDirectory(dirname(path));
          });
        }

        return null;
      });
    });
  }

  exportGuards(input: AuthorityInput<"exportGuards">) {
    return Effect.gen({ self: this }, function* () {
      const guards = (yield* this.journal.exportMetadata())
        .filter(
          (guard) =>
            guard.volume === input.volume &&
            (input.after === null || byteOrder(guard.token, input.after) > 0),
        )
        .sort((a, b) => byteOrder(a.token, b.token));

      const page = guards.slice(0, input.limit);

      return {
        exports: page,
        next: guards.length > input.limit ? (page.at(-1)?.token ?? null) : null,
      };
    });
  }

  recoverable(input: AuthorityInput<"recoverable">) {
    return Effect.gen({ self: this }, function* () {
      const entries = [
        ...(yield* this.journal.records())
          .filter((record) => record.kind === "started")
          .map((record) => ({ key: `a:${record.plan.id}`, record })),
        ...(yield* this.journal.guards()).map((guard) => ({ key: `e:${guard.attemptId}`, guard })),
      ]
        .filter((entry) => input.after === null || byteOrder(entry.key, input.after) > 0)
        .sort((a, b) => byteOrder(a.key, b.key));

      const page = entries.slice(0, input.limit);

      return {
        attempts: page.flatMap((entry) => ("record" in entry ? [entry.record] : [])),
        exports: page.flatMap((entry) => ("guard" in entry ? [entry.guard] : [])),
        next: entries.length > input.limit ? (page.at(-1)?.key ?? null) : null,
      };
    });
  }

  close() {
    return Effect.gen({ self: this }, function* () {
      this.closed = true;
      yield* this.mutex.withPermit(Effect.void);
    });
  }
}
