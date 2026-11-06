import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Semaphore } from "effect";
import {
  AuthorityError,
  type AuthoritySession,
  artifactHelperName,
} from "../../../../packages/loopy/src/contract/sandbox-journal";
import type {
  AuthorityInput,
  AuthorityOutput,
} from "../../../../packages/loopy/src/contract/sandbox-journal-rpc";
import { FilesystemResults, resultReference } from "../immutable-results";
import { missing, syncDirectory, writeAtomic } from "../journal-files";
import type { SandboxAttemptAuthority, SandboxOperationError } from "../operations";
import { io } from "../operations";
import { FilesystemJournal } from "./journal";

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

  private current(session: AuthoritySession) {
    return this.session?.epoch === session.epoch && this.session.nonce === session.nonce;
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

  read(id: string) {
    return this.journal.read(id);
  }

  admit(
    input: AuthorityInput<"admit">,
  ): Effect.Effect<AuthorityOutput<"admit">, SandboxOperationError | AuthorityError> {
    return this.serial(() => {
      return Effect.gen({ self: this }, function* () {
        if (!this.current(input.session)) {
          return { kind: "rejected", code: "stale_session" };
        }

        if (!this.journal.validPlan(input.plan)) {
          return { kind: "rejected", code: "invalid_state" };
        }

        const existing = yield* this.read(input.plan.id);

        if (existing) {
          return existing.plan.requestHash === input.plan.requestHash
            ? { kind: "existing", record: existing }
            : { kind: "rejected", code: "request_conflict" };
        }

        if ((yield* this.journal.guards()).some((guard) => guard.volume === input.plan.volume)) {
          return { kind: "rejected", code: "workspace_busy" };
        }

        const record = { kind: "started", plan: input.plan, session: input.session } as const;
        yield* io("filesystem-authority", () =>
          writeAtomic(join(this.root, "receipts", `${input.plan.id}.json`), record),
        );

        return { kind: "created", record };
      });
    });
  }

  complete(
    input: AuthorityInput<"complete">,
  ): Effect.Effect<AuthorityOutput<"complete">, SandboxOperationError | AuthorityError> {
    return this.serial(() => {
      return Effect.gen({ self: this }, function* () {
        if (!this.current(input.session)) {
          return { kind: "rejected", code: "stale_session" };
        }

        const existing = yield* this.read(input.id);

        if (!existing) {
          return { kind: "rejected", code: "missing" };
        }

        if (existing.plan.requestHash !== input.requestHash) {
          return { kind: "rejected", code: "request_conflict" };
        }

        if (existing.kind === "finished") {
          const ref =
            existing.result.kind === "blob"
              ? existing.result.ref
              : resultReference(existing.result.value);

          return ref.sha256 === input.result.sha256 && ref.size === input.result.size
            ? { kind: "finished", record: existing }
            : { kind: "rejected", code: "request_conflict" };
        }

        yield* new FilesystemResults(this.root, existing.plan.workspace).get(input.result);

        const record = {
          ...existing,
          kind: "finished",
          result: { kind: "blob", ref: input.result },
        } as const;

        yield* io("filesystem-authority", () =>
          writeAtomic(join(this.root, "receipts", `${input.id}.json`), record),
        );

        return { kind: "finished", record };
      });
    });
  }

  beginExport(
    input: AuthorityInput<"beginExport">,
  ): Effect.Effect<AuthorityOutput<"beginExport">, SandboxOperationError | AuthorityError> {
    return this.serial(() => {
      return Effect.gen({ self: this }, function* () {
        if (!this.current(input.session)) {
          return { kind: "rejected", code: "stale_session" };
        }

        const guards = yield* this.journal.guards();
        const released = yield* this.journal.released(input.token);

        if (released) {
          return {
            kind: "rejected",
            code: released.attemptId === input.attemptId ? "invalid_state" : "request_conflict",
          };
        }

        const same = guards.find((guard) => guard.token === input.token);

        if (same) {
          return same.attemptId === input.attemptId
            ? { kind: "granted", record: same }
            : { kind: "rejected", code: "request_conflict" };
        }

        const receipt = yield* this.read(input.attemptId);

        if (!receipt) {
          return { kind: "rejected", code: "missing" };
        }

        if (receipt.kind !== "finished") {
          return { kind: "rejected", code: "invalid_state" };
        }

        if (
          guards.some((guard) => guard.volume === receipt.plan.volume) ||
          (yield* this.journal.records()).some(
            (record) => record.kind === "started" && record.plan.volume === receipt.plan.volume,
          )
        ) {
          return { kind: "rejected", code: "workspace_busy" };
        }

        const record = {
          token: input.token,
          session: input.session,
          attemptId: input.attemptId,
          volume: receipt.plan.volume,
          helper: artifactHelperName(input.attemptId),
        };

        yield* io("filesystem-authority", () =>
          writeAtomic(join(this.root, "exports", `${input.attemptId}.json`), record),
        );

        return { kind: "granted", record };
      });
    });
  }

  endExport(input: AuthorityInput<"endExport">) {
    return this.serial(() => {
      return Effect.gen({ self: this }, function* () {
        if (!this.current(input.session)) {
          return yield* Effect.fail(new AuthorityError("stale_session"));
        }

        const guard = (yield* this.journal.guards()).find((record) => record.token === input.token);

        if (guard) {
          yield* io("filesystem-authority", () =>
            writeAtomic(this.journal.releasedPath(guard.token), guard),
          );
          yield* io("filesystem-authority", () =>
            unlink(join(this.root, "exports", `${guard.attemptId}.json`)).catch(
              (cause: unknown) => {
                if (!missing(cause)) {
                  throw cause;
                }
              },
            ),
          );
          yield* io("filesystem-authority", () => syncDirectory(join(this.root, "exports")));
        }
      });
    });
  }

  exportGuards(input: AuthorityInput<"exportGuards">) {
    return Effect.gen({ self: this }, function* () {
      const guards = (yield* this.journal.exportMetadata())
        .filter(
          (guard) =>
            guard.volume === input.volume &&
            (input.after === null ||
              Buffer.compare(Buffer.from(guard.token), Buffer.from(input.after)) > 0),
        )
        .sort((a, b) => Buffer.compare(Buffer.from(a.token), Buffer.from(b.token)));

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
        .filter((entry) => input.after === null || entry.key > input.after)
        .sort((a, b) => a.key.localeCompare(b.key));

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
