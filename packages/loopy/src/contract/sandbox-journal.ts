import { z } from "zod";
import { hashSchema } from "./compiled-loopy.js";
import {
  SANDBOX_MAX_CAPTURE_BYTES,
  type SandboxExecutionResult,
  sandboxAttemptIdentitySchema,
  sandboxExecutionResultSchema,
} from "./sandbox.js";

export const authoritySessionSchema = z.strictObject({
  epoch: z.number().int().positive(),
  nonce: z.string().min(1).max(256),
});

export const dockerAttemptPlanSchema = sandboxAttemptIdentitySchema.extend({
  id: hashSchema,
  requestHash: hashSchema,
  container: z.string().regex(/^loopy-attempt-[a-f0-9]{64}$/),
  inputVolume: z.string().regex(/^loopy-input-[a-f0-9]{64}$/),
  volume: z.string().regex(/^loopy-workspace-[a-f0-9]{64}$/),
  deadline: z.number().int().positive(),
});

export const resultRefSchema = z.strictObject({
  sha256: hashSchema,
  size: z.number().int().positive().max(SANDBOX_MAX_CAPTURE_BYTES),
});

export const resultLocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("blob"), ref: resultRefSchema }),
  z.strictObject({ kind: z.literal("inline"), value: sandboxExecutionResultSchema }),
]);

export const startedAttemptRecordSchema = z.strictObject({
  kind: z.literal("started"),
  plan: dockerAttemptPlanSchema,
  session: authoritySessionSchema,
});

export const finishedAttemptRecordSchema = z.strictObject({
  kind: z.literal("finished"),
  plan: dockerAttemptPlanSchema,
  session: authoritySessionSchema,
  result: resultLocationSchema,
});

export const attemptRecordSchema = z.discriminatedUnion("kind", [
  startedAttemptRecordSchema,
  finishedAttemptRecordSchema,
]);

export const exportRecordSchema = z.strictObject({
  token: z.string().min(1).max(256),
  session: authoritySessionSchema,
  attemptId: hashSchema,
  volume: dockerAttemptPlanSchema.shape.volume,
  helper: z.string().regex(/^loopy-artifact-[a-f0-9]{64}$/),
});

export const authorityFailureSchema = z.enum([
  "request_conflict",
  "workspace_busy",
  "stale_session",
  "missing",
  "invalid_state",
]);

export type AuthoritySession = z.infer<typeof authoritySessionSchema>;

export type DockerAttemptPlan = z.infer<typeof dockerAttemptPlanSchema>;

export type ResultRef = z.infer<typeof resultRefSchema>;

export type ResultLocation = z.infer<typeof resultLocationSchema>;

export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

export type ExportRecord = z.infer<typeof exportRecordSchema>;

export type AuthorityFailure = z.infer<typeof authorityFailureSchema>;

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
