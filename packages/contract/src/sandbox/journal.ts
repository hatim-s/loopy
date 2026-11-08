import {
  type ExecutionResult,
  executionResultSchema,
  hashSchema,
  positiveInt,
  struct,
} from "@loopy/core";
import { Schema } from "effect";
import { boundedToken } from "./codec";
import {
  SANDBOX_MAX_CAPTURE_BYTES,
  type SandboxAttemptIdentity,
  sandboxAttemptIdentitySchema,
} from "./sandbox";

export const authoritySessionSchema = struct({
  epoch: positiveInt,
  nonce: boundedToken,
});

export const dockerAttemptPlanSchema = struct({
  ...sandboxAttemptIdentitySchema.fields,
  id: hashSchema,
  requestHash: hashSchema,
  container: Schema.String.check(Schema.isPattern(/^loopy-attempt-[a-f0-9]{64}$/)),
  inputVolume: Schema.String.check(Schema.isPattern(/^loopy-input-[a-f0-9]{64}$/)),
  volume: Schema.String.check(Schema.isPattern(/^loopy-workspace-[a-f0-9]{64}$/)),
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
  put(result: ExecutionResult): Promise<ResultRef>;
  get(ref: ResultRef): Promise<ExecutionResult>;
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
