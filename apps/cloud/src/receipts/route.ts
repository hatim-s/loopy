import { decodeBoundary, SANDBOX_MAX_REQUEST_BYTES } from "@loopy/contract";
import { bearerMatches } from "@loopy/runtime/service";
import { Effect, Schema } from "effect";
import type { Environment } from "../environment";
import { cloudConfig } from "../environment";
import { readBoundedText } from "../http";
import { platform } from "../operation";

export const RECEIPTS_PATH = "/internal/sandbox-receipts";

const configurationSchema = Schema.Struct({
  token: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(256)),
  namespace: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/),
  ),
  root: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4096),
    Schema.makeFilter(
      (root) =>
        root.startsWith("/") &&
        root
          .slice(1)
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".."),
    ),
  ),
});

export function receiptsConfiguration(env: Environment) {
  const config = decodeBoundary(configurationSchema)({
    token: env.RECEIPTS_TOKEN,
    namespace: env.RECEIPTS_NAMESPACE,
    root: env.RECEIPTS_ROOT,
  });

  if (cloudConfig(env).principals.some(({ token }) => token === config.token)) {
    throw new Error("Receipt bridge credentials must differ from user principal credentials.");
  }

  return config;
}

export function receiptAccess(request: Request, env: Environment): Response | null {
  const url = new URL(request.url);

  if (
    env.LOOPY_STAGE !== "local" ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.pathname !== RECEIPTS_PATH ||
    request.headers.has("Origin")
  ) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const config = receiptsConfiguration(env);

  if (!bearerMatches(request.headers.get("Authorization"), config.token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (request.headers.get("X-Loopy-Receipts-Namespace") !== config.namespace) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  return null;
}

export function routeReceipts(request: Request, env: Environment) {
  return Effect.gen(function* () {
    const rejected = receiptAccess(request, env);

    if (rejected) {
      return rejected;
    }

    const stub = env.SANDBOX_RECEIPTS.get(env.SANDBOX_RECEIPTS.idFromName(env.RECEIPTS_NAMESPACE));

    if (request.body === null) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const body = yield* readBoundedText(new Response(request.body), SANDBOX_MAX_REQUEST_BYTES).pipe(
      Effect.catchTag("BodyLimitError", () => Effect.succeed(null)),
    );

    if (body === null) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const response = yield* platform("forward receipt command", () =>
      stub.fetch(request.url, {
        method: request.method,
        headers: [...request.headers],
        body,
      }),
    );

    return new Response(yield* platform("read receipt response", () => response.arrayBuffer()), {
      status: response.status,
      headers: [...response.headers],
    });
  });
}
