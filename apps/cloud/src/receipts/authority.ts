import {
  AuthorityError,
  type AuthorityFailure,
  type AuthorityInput,
  type AuthorityOutput,
  artifactHelperName,
  type ExportRecord,
} from "@loopy/contract";
import type { ReceiptSql } from "./sql";

function checked<T>(work: () => T): T | { kind: "rejected"; code: AuthorityFailure } {
  try {
    return work();
  } catch (error) {
    if (error instanceof AuthorityError) {
      return { kind: "rejected", code: error.code };
    }

    throw error;
  }
}

export class ReceiptAuthority {
  constructor(private readonly db: ReceiptSql) {}

  admit(input: AuthorityInput<"admit">): AuthorityOutput<"admit"> {
    return checked(() =>
      this.db.storage.transactionSync(() => {
        this.db.checkSession(input.session);
        const existing = this.db.read(input.plan.id);

        if (existing) {
          if (existing.plan.requestHash !== input.plan.requestHash) {
            throw new AuthorityError("request_conflict");
          }

          return { kind: "existing" as const, record: existing };
        }

        if (this.db.busy(input.plan.volume)) {
          throw new AuthorityError("workspace_busy");
        }

        const record = { kind: "started" as const, plan: input.plan, session: input.session };
        this.db.write(record);

        return { kind: "created" as const, record };
      }),
    );
  }

  complete(input: AuthorityInput<"complete">): AuthorityOutput<"complete"> {
    return checked(() =>
      this.db.storage.transactionSync(() => {
        this.db.checkSession(input.session);
        const previous = this.db.read(input.id);

        if (!previous) {
          throw new AuthorityError("missing");
        }

        if (previous.plan.requestHash !== input.requestHash) {
          throw new AuthorityError("request_conflict");
        }

        if (previous.kind === "finished") {
          if (
            previous.result.kind !== "blob" ||
            previous.result.ref.sha256 !== input.result.sha256 ||
            previous.result.ref.size !== input.result.size
          ) {
            throw new AuthorityError("request_conflict");
          }

          return { kind: "finished" as const, record: previous };
        }

        const record = {
          ...previous,
          kind: "finished" as const,
          result: { kind: "blob" as const, ref: input.result },
        };

        this.db.write(record);

        return { kind: "finished" as const, record };
      }),
    );
  }

  beginExport(input: AuthorityInput<"beginExport">): AuthorityOutput<"beginExport"> {
    return checked(() =>
      this.db.storage.transactionSync(() => {
        this.db.checkSession(input.session);
        const existing = this.db.export(input.token);

        if (existing) {
          if (existing.record.attemptId !== input.attemptId) {
            throw new AuthorityError("request_conflict");
          }

          if (!existing.active) {
            throw new AuthorityError("invalid_state");
          }

          return { kind: "granted" as const, record: existing.record };
        }

        const attempt = this.db.read(input.attemptId);

        if (!attempt) {
          throw new AuthorityError("missing");
        }

        if (attempt.kind !== "finished") {
          throw new AuthorityError("invalid_state");
        }

        const volume = attempt.plan.volume;

        const pending =
          this.db.storage.sql
            .exec(
              "SELECT id FROM receipt_attempts WHERE volume=? AND kind='started' LIMIT 1",
              volume,
            )
            .toArray().length > 0;

        if (pending || this.db.busy(volume)) {
          throw new AuthorityError("workspace_busy");
        }

        const record: ExportRecord = {
          token: input.token,
          session: input.session,
          attemptId: input.attemptId,
          volume,
          helper: artifactHelperName(input.attemptId),
        };

        this.db.storage.sql
          .exec(
            "INSERT INTO receipt_exports VALUES (?,?,1,?)",
            input.token,
            volume,
            JSON.stringify(record),
          )
          .toArray();

        return { kind: "granted" as const, record };
      }),
    );
  }

  endExport(input: AuthorityInput<"endExport">): void {
    this.db.storage.transactionSync(() => {
      this.db.checkSession(input.session);
      const previous = this.db.export(input.token);

      if (!previous) {
        throw new AuthorityError("missing");
      }

      this.db.storage.sql
        .exec("UPDATE receipt_exports SET active=0 WHERE token=?", input.token)
        .toArray();
    });
  }
}
