import type { DurableObjectState } from "@cloudflare/workers-types";
import { decodeBoundary } from "@loopy/contract";
import { authorityOperations } from "@loopy/contract/sandbox";
import { Schema } from "effect";
import { ReceiptAuthority } from "../../../../apps/cloud/src/receipts/authority";
import { ReceiptSql } from "../../../../apps/cloud/src/receipts/sql";
import { receiptRecoveryProbe } from "./receipt-recovery-probe";

export class ReceiptRollbackProbe {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request) {
    const db = new ReceiptSql(this.ctx.storage, "rollback", "/synthetic/rollback");
    const authority = new ReceiptAuthority(db);
    const input = decodeBoundary(authorityOperations.admit.input)(await request.json());
    db.openSession({ expectedEpoch: 0, nonce: input.session.nonce });

    if (new URL(request.url).pathname === "/recovery") {
      return Response.json(receiptRecoveryProbe(db, input));
    }

    let failure = "did not reject";

    try {
      this.ctx.storage.transactionSync(() => {
        authority.admit(input, true);
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

const forwardedRequest = Schema.Struct({
  url: Schema.String,
  method: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.optionalKey(Schema.String),
});

export default {
  async fetch(request: Request, env: { CLOUD: { fetch(request: Request): Promise<Response> } }) {
    if (new URL(request.url).pathname !== "/forward") {
      return new Response("Probe requires its Durable Object binding.", { status: 404 });
    }

    const input = decodeBoundary(forwardedRequest)(await request.json());

    // Construct inside workerd so Miniflare's control proxy cannot consume Origin or rewrite the URL.
    return env.CLOUD.fetch(new Request(input.url, input));
  },
};
