import {
  AuthorityError,
  type AuthorityInput,
  type AuthorityOutput,
  admitTransition,
  beginExportTransition,
  completeTransition,
  endExportTransition,
} from "@loopy/contract/sandbox";
import type { ReceiptSql } from "./sql";

/** Applies the shared receipt transitions inside synchronous Durable Object transactions. */
export class ReceiptAuthority {
  constructor(private readonly db: ReceiptSql) {}

  admit(input: AuthorityInput<"admit">, validPlan: boolean): AuthorityOutput<"admit"> {
    return this.db.storage.transactionSync(() => {
      const decision = admitTransition(input, {
        current: this.db.current(),
        validPlan,
        existing: this.db.read(input.plan.id),
        workspaceBusy: this.db.busy(input.plan.volume),
      });

      if (decision.kind === "created") {
        this.db.write(decision.record);
      }

      return decision;
    });
  }

  /** Decides without writing, so the caller can verify result bytes outside the transaction. */
  completion(input: AuthorityInput<"complete">) {
    return completeTransition(input, {
      current: this.db.current(),
      existing: this.db.read(input.id),
      inlineRef: null,
    });
  }

  complete(input: AuthorityInput<"complete">): AuthorityOutput<"complete"> {
    return this.db.storage.transactionSync(() => {
      const decision = this.completion(input);

      if (decision.kind !== "publish") {
        return decision;
      }

      this.db.write(decision.record);

      return { kind: "finished", record: decision.record };
    });
  }

  beginExport(input: AuthorityInput<"beginExport">): AuthorityOutput<"beginExport"> {
    return this.db.storage.transactionSync(() => {
      const decision = beginExportTransition(input, {
        current: this.db.current(),
        token: this.db.export(input.token),
        attempt: this.db.read(input.attemptId),
        workspaceBusy: (volume) => this.db.pendingStarted(volume) || this.db.busy(volume),
      });

      if (decision.kind !== "create") {
        return decision;
      }

      this.db.insertExport(decision.record);

      return { kind: "granted", record: decision.record };
    });
  }

  endExport(input: AuthorityInput<"endExport">): null {
    return this.db.storage.transactionSync(() => {
      const decision = endExportTransition(input, {
        current: this.db.current(),
        active: this.db.export(input.token)?.active ?? false,
      });

      if (decision.kind === "rejected") {
        throw new AuthorityError(decision.code);
      }

      if (decision.kind === "release") {
        this.db.releaseExport(input.token);
      }

      return null;
    });
  }
}
