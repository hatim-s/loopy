import { z } from "zod";
import { SANDBOX_MAX_REQUEST_BYTES } from "../../../packages/loopy/src/contract/index.js";
import type { Environment } from "./environment.js";
import { principals } from "./environment.js";
import { readBoundedText } from "./http.js";

export const RECEIPTS_PATH = "/internal/sandbox-receipts";

const configurationSchema = z.strictObject({
  token: z.string().min(32).max(256),
  namespace: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
  root: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (root) =>
        root.startsWith("/") &&
        root
          .slice(1)
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".."),
    ),
});

export function receiptsConfiguration(env: Environment) {
  const config = configurationSchema.parse({
    token: env.RECEIPTS_TOKEN,
    namespace: env.RECEIPTS_NAMESPACE,
    root: env.RECEIPTS_ROOT,
  });

  if (principals(env).some(({ token }) => token === config.token)) {
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

  if (request.headers.get("Authorization") !== `Bearer ${config.token}`) {
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

export async function routeReceipts(request: Request, env: Environment): Promise<Response> {
  const rejected = receiptAccess(request, env);

  if (rejected) {
    return rejected;
  }

  const stub = env.SANDBOX_RECEIPTS.get(env.SANDBOX_RECEIPTS.idFromName(env.RECEIPTS_NAMESPACE));

  let body: string;

  try {
    body = await readBoundedText(new Response(request.body), SANDBOX_MAX_REQUEST_BYTES);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const response = await stub.fetch(request.url, {
    method: request.method,
    headers: [...request.headers],
    body,
  });

  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: [...response.headers],
  });
}
