import { Schema } from "effect";
import { struct } from "./codec.js";

import { hashSchema } from "./compiled-loopy.js";
import {
  SANDBOX_MAX_CAPTURE_BYTES,
  type SandboxAttemptIdentity,
  type SandboxExecutionResult,
  sandboxAttemptIdentitySchema,
  sandboxExecutionResultSchema,
} from "./sandbox.js";

export const authoritySessionSchema = struct({
  epoch: Schema.Int.check(Schema.isGreaterThan(0)),
  nonce: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(256)),
});

export const dockerAttemptPlanSchema = struct({
  ...sandboxAttemptIdentitySchema.fields,
  id: hashSchema,
  requestHash: hashSchema,
  container: Schema.String.check(Schema.isPattern(/^loopy-attempt-[a-f0-9]{64}$/)),
  inputVolume: Schema.String.check(Schema.isPattern(/^loopy-input-[a-f0-9]{64}$/)),
  volume: Schema.String.check(Schema.isPattern(/^loopy-workspace-[a-f0-9]{64}$/)),
  deadline: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const resultRefSchema = struct({
  sha256: hashSchema,
  size: Schema.Int.check(Schema.isGreaterThan(0)).check(
    Schema.isLessThanOrEqualTo(SANDBOX_MAX_CAPTURE_BYTES),
  ),
});

export const resultLocationSchema = Schema.Union([
  struct({ kind: Schema.Literal("blob"), ref: resultRefSchema }),
  struct({ kind: Schema.Literal("inline"), value: sandboxExecutionResultSchema }),
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
  token: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(256)),
  session: authoritySessionSchema,
  attemptId: hashSchema,
  volume: dockerAttemptPlanSchema.fields.volume,
  helper: Schema.String.check(Schema.isPattern(/^loopy-artifact-[a-f0-9]{64}$/)),
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

export type ResultLocation = Schema.Schema.Type<typeof resultLocationSchema>;

export type AttemptRecord = Schema.Schema.Type<typeof attemptRecordSchema>;

export type ExportRecord = Schema.Schema.Type<typeof exportRecordSchema>;

export type AuthorityFailure = Schema.Schema.Type<typeof authorityFailureSchema>;

export class AuthorityError extends Error {
  constructor(readonly code: AuthorityFailure) {
    super(`Sandbox authority rejected operation: ${code}.`);
  }
}

export interface ImmutableResults {
  put(result: SandboxExecutionResult): Promise<ResultRef>;
  get(ref: ResultRef): Promise<SandboxExecutionResult>;
}

// Composition binds the workspace before any bytes or digest select storage paths.
export type ResultsFor = (workspace: string) => ImmutableResults;

export function attemptIdInput(root: string, identity: SandboxAttemptIdentity) {
  return {
    root,
    workspace: identity.workspace,
    executionKey: identity.executionKey,
    attempt: identity.attempt,
  };
}

export function workspaceVolumeInput(root: string, identity: SandboxAttemptIdentity) {
  return { root, workspace: identity.workspace, runId: identity.executionKey.runId };
}

export function attemptResourceNames(id: string, volumeHash: string) {
  return {
    container: `loopy-attempt-${id}`,
    inputVolume: `loopy-input-${id}`,
    volume: `loopy-workspace-${volumeHash}`,
  };
}

export function artifactHelperName(id: string) {
  return `loopy-artifact-${id}`;
}
