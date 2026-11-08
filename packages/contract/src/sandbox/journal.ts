import { executionResultSchema, hashSchema, positiveInt, struct } from "@loopy/core";
import { Schema } from "effect";
import { boundedToken } from "../codec";
import { SANDBOX_MAX_CAPTURE_BYTES, sandboxAttemptIdentitySchema } from "./attempt";

// Docker names carry these prefixes followed by a SHA-256 hex digest.
const PREFIX = {
  container: "loopy-attempt-",
  inputVolume: "loopy-input-",
  volume: "loopy-workspace-",
  artifactHelper: "loopy-artifact-",
} as const;

const resourceName = (prefix: string) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^${prefix}[a-f0-9]{64}$`)));

export function attemptResourceNames(id: string, volumeHash: string) {
  return {
    container: `${PREFIX.container}${id}`,
    inputVolume: `${PREFIX.inputVolume}${id}`,
    volume: `${PREFIX.volume}${volumeHash}`,
  };
}

export function artifactHelperName(id: string) {
  return `${PREFIX.artifactHelper}${id}`;
}

/** The stopped helper that stages request files into the input volume. */
export function inputHelperName(plan: { container: string }) {
  return `${plan.container}-input`;
}

export const authoritySessionSchema = struct({
  epoch: positiveInt,
  nonce: boundedToken,
});

export const dockerAttemptPlanSchema = struct({
  ...sandboxAttemptIdentitySchema.fields,
  id: hashSchema,
  requestHash: hashSchema,
  container: resourceName(PREFIX.container),
  inputVolume: resourceName(PREFIX.inputVolume),
  volume: resourceName(PREFIX.volume),
  deadline: positiveInt,
});

export const resultRefSchema = struct({
  sha256: hashSchema,
  size: positiveInt.check(Schema.isLessThanOrEqualTo(SANDBOX_MAX_CAPTURE_BYTES)),
});

const resultLocationSchema = Schema.Union([
  struct({ kind: Schema.Literal("blob"), ref: resultRefSchema }),
  struct({ kind: Schema.Literal("inline"), value: executionResultSchema }),
]);

export const startedAttemptRecordSchema = struct({
  kind: Schema.Literal("started"),
  plan: dockerAttemptPlanSchema,
  session: authoritySessionSchema,
});

export const finishedAttemptRecordSchema = struct({
  kind: Schema.Literal("finished"),
  plan: dockerAttemptPlanSchema,
  session: authoritySessionSchema,
  result: resultLocationSchema,
});

export const attemptRecordSchema = Schema.Union([
  startedAttemptRecordSchema,
  finishedAttemptRecordSchema,
]);

export const exportRecordSchema = struct({
  token: boundedToken,
  session: authoritySessionSchema,
  attemptId: hashSchema,
  volume: dockerAttemptPlanSchema.fields.volume,
  helper: resourceName(PREFIX.artifactHelper),
});

export const authorityFailureSchema = Schema.Literals([
  "request_conflict",
  "workspace_busy",
  "stale_session",
  "missing",
  "invalid_state",
]);

export type AuthoritySession = Schema.Schema.Type<typeof authoritySessionSchema>;

export type DockerAttemptPlan = Schema.Schema.Type<typeof dockerAttemptPlanSchema>;

export type ResultRef = Schema.Schema.Type<typeof resultRefSchema>;

export type AttemptRecord = Schema.Schema.Type<typeof attemptRecordSchema>;

export type StartedAttemptRecord = Schema.Schema.Type<typeof startedAttemptRecordSchema>;

export type FinishedAttemptRecord = Schema.Schema.Type<typeof finishedAttemptRecordSchema>;

export type ExportRecord = Schema.Schema.Type<typeof exportRecordSchema>;

export type AuthorityFailure = Schema.Schema.Type<typeof authorityFailureSchema>;

export class AuthorityError extends Error {
  constructor(readonly code: AuthorityFailure) {
    super(`Sandbox authority rejected operation: ${code}.`);
  }
}
