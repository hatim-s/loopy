import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import type { Environment } from "../../../../apps/cloud/src/environment";
import { SandboxReceipts } from "../../../../apps/cloud/src/receipts";

export class ReceiptCountProbe extends SandboxReceipts {
  private readonly counts;

  constructor(ctx: DurableObjectState, env: Environment) {
    const counts = { get: 0, put: 0 };

    const bucket: R2Bucket = {
      ...env.RECEIPT_RESULTS,
      get: (...args: Parameters<R2Bucket["get"]>) => {
        counts.get++;

        return env.RECEIPT_RESULTS.get(...args);
      },
      put: (...args: Parameters<R2Bucket["put"]>) => {
        counts.put++;

        return env.RECEIPT_RESULTS.put(...args);
      },
    };

    super(ctx, { ...env, RECEIPT_RESULTS: bucket });
    this.counts = counts;
  }

  override async fetch(request: Request) {
    if (new URL(request.url).pathname === "/counts") {
      return Response.json(this.counts);
    }

    return super.fetch(request);
  }
}

export default {
  fetch: () => new Response("Probe requires its Durable Object binding.", { status: 404 }),
};
