import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";
import { Schema } from "effect";
import { decodeBoundary } from "../../../packages/loopy/src/contract";

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
  RECEIPTS_TOKEN: string;
  RECEIPTS_NAMESPACE: string;
  RECEIPTS_ROOT: string;
}

const principalsSchema = Schema.Array(
  Schema.Struct({
    token: Schema.String.check(Schema.isMinLength(32)),
    workspace: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/)),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(16));

const concurrencySchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 }));

export function principals(env: Environment) {
  return decodeBoundary(principalsSchema)(JSON.parse(env.LOCAL_AUTH));
}

export function concurrency(env: Environment): number {
  return decodeBoundary(concurrencySchema)(Number(env.CONCURRENCY));
}

export function localEndpoint(value: string): URL {
  const url = new URL(value);

  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Phase 1 requires a loopback HTTP sandbox URL without credentials or a path.");
  }

  return url;
}
