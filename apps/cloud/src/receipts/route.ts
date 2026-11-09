import { SANDBOX_MAX_REQUEST_BYTES } from "@loopy/contract/sandbox";
import { bearerMatches, readBoundedBody } from "@loopy/runtime/service";
import { Effect } from "effect";
import type { Environment } from "../environment";
import { cloudConfig } from "../environment";
import { platform } from "../operation";

export const RECEIPTS_PATH = "/internal/sandbox-receipts";

/** The Worker calls this after servesLocally, so only the local stage on loopback reaches it. */
export function routeReceipts(request: Request, env: Environment) {
  return Effect.gen(function* () {
    const receipts = cloudConfig(env).receipts;

    if (receipts === null) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    if (new URL(request.url).protocol !== "http:" || request.headers.has("Origin")) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }

    if (!bearerMatches(request.headers.get("Authorization"), receipts.token)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    if (request.headers.get("X-Loopy-Receipts-Namespace") !== receipts.namespace) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }

    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }

    const body = yield* readBoundedBody(request.body, SANDBOX_MAX_REQUEST_BYTES).pipe(
      Effect.catchTag("BodyLimitError", () => Effect.succeed(null)),
    );

    if (body === null || body.byteLength === 0) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const stub = env.SANDBOX_RECEIPTS.get(env.SANDBOX_RECEIPTS.idFromName(receipts.namespace));

    const response = yield* platform("forward receipt command", () =>
      stub.fetch(request.url, { method: "POST", body }),
    );

    return new Response(yield* platform("read receipt response", () => response.arrayBuffer()), {
      status: response.status,
      headers: [...response.headers],
    });
  });
}
