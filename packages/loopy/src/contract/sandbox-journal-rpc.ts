import { z } from "zod";
import { hashSchema } from "./compiled-loopy.js";
import { sandboxExecutionResultSchema } from "./sandbox.js";
import {
  type AuthoritySession,
  attemptRecordSchema,
  authorityFailureSchema,
  authoritySessionSchema,
  dockerAttemptPlanSchema,
  exportRecordSchema,
  finishedAttemptRecordSchema,
  resultRefSchema,
  startedAttemptRecordSchema,
} from "./sandbox-journal.js";

const rejected = z.strictObject({ kind: z.literal("rejected"), code: authorityFailureSchema });

const session = { session: authoritySessionSchema };

export const authorityOperations = {
  status: {
    input: z.strictObject({}),
    output: z.strictObject({ epoch: z.number().int().nonnegative() }),
  },
  openSession: {
    input: z.strictObject({
      expectedEpoch: z.number().int().nonnegative(),
      nonce: z.string().min(1).max(256),
    }),
    output: authoritySessionSchema,
  },
  read: {
    input: z.strictObject({ id: hashSchema }),
    output: attemptRecordSchema.nullable(),
  },
  admit: {
    input: z.strictObject({ ...session, plan: dockerAttemptPlanSchema }),
    output: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("created"), record: startedAttemptRecordSchema }),
      z.strictObject({ kind: z.literal("existing"), record: attemptRecordSchema }),
      rejected,
    ]),
  },
  complete: {
    input: z.strictObject({
      ...session,
      id: hashSchema,
      requestHash: hashSchema,
      result: resultRefSchema,
    }),
    output: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("finished"), record: finishedAttemptRecordSchema }),
      rejected,
    ]),
  },
  beginExport: {
    input: z.strictObject({ ...session, attemptId: hashSchema, token: z.string().min(1).max(256) }),
    output: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("granted"), record: exportRecordSchema }),
      rejected,
    ]),
  },
  endExport: {
    input: z.strictObject({ ...session, token: z.string().min(1).max(256) }),
    output: z.null(),
  },
  recoverable: {
    input: z.strictObject({
      after: z.string().nullable(),
      limit: z.number().int().min(1).max(200),
    }),
    output: z.strictObject({
      attempts: z.array(startedAttemptRecordSchema),
      exports: z.array(exportRecordSchema),
      next: z.string().nullable(),
    }),
  },
};

export type AuthorityInput<K extends keyof typeof authorityOperations> = z.infer<
  (typeof authorityOperations)[K]["input"]
>;

export type AuthorityOutput<K extends keyof typeof authorityOperations> = z.infer<
  (typeof authorityOperations)[K]["output"]
>;

export interface SandboxAttemptAuthority {
  status(): Promise<AuthorityOutput<"status">>;
  openSession(input: AuthorityInput<"openSession">): Promise<AuthoritySession>;
  read(id: string): Promise<AuthorityOutput<"read">>;
  admit(input: AuthorityInput<"admit">): Promise<AuthorityOutput<"admit">>;
  complete(input: AuthorityInput<"complete">): Promise<AuthorityOutput<"complete">>;
  beginExport(input: AuthorityInput<"beginExport">): Promise<AuthorityOutput<"beginExport">>;
  endExport(input: AuthorityInput<"endExport">): Promise<void>;
  recoverable(input: AuthorityInput<"recoverable">): Promise<AuthorityOutput<"recoverable">>;
}

export const resultOperations = {
  resultPut: {
    input: z.strictObject({
      workspace: dockerAttemptPlanSchema.shape.workspace,
      value: sandboxExecutionResultSchema,
    }),
    output: resultRefSchema,
  },
  resultGet: {
    input: z.strictObject({
      workspace: dockerAttemptPlanSchema.shape.workspace,
      ref: resultRefSchema,
    }),
    output: sandboxExecutionResultSchema,
  },
};

export const authorityCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("status"), input: authorityOperations.status.input }),
  z.strictObject({
    operation: z.literal("openSession"),
    input: authorityOperations.openSession.input,
  }),
  z.strictObject({ operation: z.literal("read"), input: authorityOperations.read.input }),
  z.strictObject({ operation: z.literal("admit"), input: authorityOperations.admit.input }),
  z.strictObject({ operation: z.literal("complete"), input: authorityOperations.complete.input }),
  z.strictObject({
    operation: z.literal("beginExport"),
    input: authorityOperations.beginExport.input,
  }),
  z.strictObject({ operation: z.literal("endExport"), input: authorityOperations.endExport.input }),
  z.strictObject({
    operation: z.literal("recoverable"),
    input: authorityOperations.recoverable.input,
  }),
  z.strictObject({ operation: z.literal("resultPut"), input: resultOperations.resultPut.input }),
  z.strictObject({ operation: z.literal("resultGet"), input: resultOperations.resultGet.input }),
]);

export const authorityErrorSchema = z.strictObject({ error: authorityFailureSchema });

export type AuthorityCommand = z.infer<typeof authorityCommandSchema>;
