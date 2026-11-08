import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";
import { decodeBoundary } from "@loopy/contract";
import { isLoopbackOrigin, isLoopbackUrl } from "@loopy/contract/sandbox";
import { Schema } from "effect";

// Wrangler passes every var as a string, so the config schema decodes from strings.
export interface Environment {
  WORKSPACES: DurableObjectNamespace;
  ARTIFACTS: R2Bucket;
  LOOPY_STAGE: string;
  LOCAL_AUTH: string;
  SANDBOX_URL: string;
  SANDBOX_TOKEN: string;
  CONCURRENCY: string;
  SANDBOX_RECEIPTS: DurableObjectNamespace;
  RECEIPT_RESULTS: R2Bucket;
  RECEIPTS_TOKEN?: string;
  RECEIPTS_NAMESPACE?: string;
  RECEIPTS_ROOT?: string;
}

export const workspaceIdSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/));

const configSchema = Schema.Struct({
  LOOPY_STAGE: Schema.Literal("local"),
  LOCAL_AUTH: Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        token: Schema.String.check(Schema.isMinLength(32)),
        workspace: workspaceIdSchema,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  ),
  CONCURRENCY: Schema.FiniteFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 16 }),
  ),
  SANDBOX_URL: Schema.String,
  SANDBOX_TOKEN: Schema.String.check(Schema.isMinLength(1)),
});

const receiptsSchema = Schema.Struct({
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

type Principal = { token: string; workspace: string };

export type CloudConfig = {
  stage: "local";
  principals: readonly Principal[];
  concurrency: number;
  sandbox: { url: URL; token: string };
  /** Null when this Worker serves no durable receipt authority. */
  receipts: typeof receiptsSchema.Type | null;
};

/** The phase 2 approval boundary: only the local stage on a loopback host is served. */
export function servesLocally(env: Pick<Environment, "LOOPY_STAGE">, url: URL): boolean {
  return env.LOOPY_STAGE === "local" && isLoopbackUrl(url);
}

function localEndpoint(value: string): URL {
  const url = new URL(value);

  if (!isLoopbackOrigin(url)) {
    throw new Error("Phase 1 requires a loopback HTTP sandbox URL without credentials or a path.");
  }

  return url;
}

function receiptsConfig(env: Environment, principals: readonly Principal[]) {
  if (
    env.RECEIPTS_TOKEN === undefined &&
    env.RECEIPTS_NAMESPACE === undefined &&
    env.RECEIPTS_ROOT === undefined
  ) {
    return null;
  }

  const receipts = decodeBoundary(receiptsSchema)({
    token: env.RECEIPTS_TOKEN,
    namespace: env.RECEIPTS_NAMESPACE,
    root: env.RECEIPTS_ROOT,
  });

  if (principals.some(({ token }) => token === receipts.token)) {
    throw new Error("Receipt bridge credentials must differ from user principal credentials.");
  }

  return receipts;
}

const parsed = new WeakMap<Environment, CloudConfig>();

/** Parses each Worker environment once; the platform reuses the same object across requests. */
export function cloudConfig(env: Environment): CloudConfig {
  const cached = parsed.get(env);

  if (cached) {
    return cached;
  }

  const vars = decodeBoundary(configSchema)({
    LOOPY_STAGE: env.LOOPY_STAGE,
    LOCAL_AUTH: env.LOCAL_AUTH,
    CONCURRENCY: env.CONCURRENCY,
    SANDBOX_URL: env.SANDBOX_URL,
    SANDBOX_TOKEN: env.SANDBOX_TOKEN,
  });

  const config: CloudConfig = {
    stage: vars.LOOPY_STAGE,
    principals: vars.LOCAL_AUTH,
    concurrency: vars.CONCURRENCY,
    sandbox: { url: localEndpoint(vars.SANDBOX_URL), token: vars.SANDBOX_TOKEN },
    receipts: receiptsConfig(env, vars.LOCAL_AUTH),
  };

  parsed.set(env, config);

  return config;
}
