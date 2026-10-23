import type { DurableObjectState } from "@cloudflare/workers-types";
import { ReceiptAuthority } from "../../../../apps/cloud/src/receipts-authority.js";
import { ReceiptSql } from "../../../../apps/cloud/src/receipts-sql.js";
import { authorityOperations } from "../../src/contract/index.js";
import { receiptRecoveryProbe } from "./receipt-recovery-probe.js";

export class ReceiptRollbackProbe {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request) {
    const db = new ReceiptSql(this.ctx.storage, "rollback", "/synthetic/rollback");
    const authority = new ReceiptAuthority(db);
    const input = authorityOperations.admit.input.parse(await request.json());
    db.openSession({ expectedEpoch: 0, nonce: input.session.nonce });

    if (new URL(request.url).pathname === "/recovery") {
      return Response.json(receiptRecoveryProbe(db, input));
    }

    let failure = "did not reject";

    try {
      this.ctx.storage.transactionSync(() => {
        authority.admit(input);
        this.ctx.storage.sql
          .exec("INSERT INTO receipt_attempts SELECT * FROM receipt_attempts")
          .toArray();
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : "non-error rejection";
    }

    return Response.json({ failure, record: db.read(input.plan.id), current: db.current() });
  }
}

export default {
  fetch: () => new Response("Probe requires its Durable Object binding.", { status: 404 }),
};
