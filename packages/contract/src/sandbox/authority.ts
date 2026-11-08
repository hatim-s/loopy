import {
  counter,
  executionResultSchema,
  hashSchema,
  PAGE_LIMIT,
  positiveInt,
  struct,
} from "@loopy/core";
import { Schema } from "effect";
import { boundedToken } from "./codec";
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
} from "./sandbox-journal";

const rejected = struct({ kind: Schema.Literal("rejected"), code: authorityFailureSchema });

const session = { session: authoritySessionSchema };

export const authorityOperations = {
  status: {
    input: struct({}),
    output: struct({ epoch: counter }),
  },
  openSession: {
    input: struct({
      expectedEpoch: counter,
      nonce: boundedToken,
    }),
    output: authoritySessionSchema,
  },
  read: { input: struct({ id: hashSchema }), output: Schema.NullOr(attemptRecordSchema) },
  admit: {
    input: struct({ ...session, plan: dockerAttemptPlanSchema }),
    output: Schema.Union([
      struct({ kind: Schema.Literal("created"), record: startedAttemptRecordSchema }),
      struct({ kind: Schema.Literal("existing"), record: attemptRecordSchema }),
      rejected,
    ]),
  },
  complete: {
    input: struct({ ...session, id: hashSchema, requestHash: hashSchema, result: resultRefSchema }),
    output: Schema.Union([
      struct({ kind: Schema.Literal("finished"), record: finishedAttemptRecordSchema }),
      rejected,
    ]),
  },
  beginExport: {
    input: struct({
      ...session,
      attemptId: hashSchema,
      token: boundedToken,
    }),
    output: Schema.Union([
      struct({ kind: Schema.Literal("granted"), record: exportRecordSchema }),
      rejected,
    ]),
  },
  endExport: {
    input: struct({
      ...session,
      token: boundedToken,
    }),
    output: Schema.Null,
  },
  exportGuards: {
    input: struct({
      after: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
      limit: positiveInt.check(Schema.isLessThanOrEqualTo(PAGE_LIMIT)),
      volume: dockerAttemptPlanSchema.fields.volume,
    }),
    output: struct({
      exports: Schema.Array(exportRecordSchema).pipe(Schema.mutable),
      next: Schema.NullOr(Schema.String),
    }),
  },
  recoverable: {
    input: struct({
      after: Schema.NullOr(Schema.String),
      limit: positiveInt.check(Schema.isLessThanOrEqualTo(PAGE_LIMIT)),
    }),
    output: struct({
      attempts: Schema.Array(startedAttemptRecordSchema).pipe(Schema.mutable),
      exports: Schema.Array(exportRecordSchema).pipe(Schema.mutable),
      next: Schema.NullOr(Schema.String),
    }),
  },
};

export type AuthorityInput<K extends keyof typeof authorityOperations> = Schema.Schema.Type<
  (typeof authorityOperations)[K]["input"]
>;

export type AuthorityOutput<K extends keyof typeof authorityOperations> = Schema.Schema.Type<
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
  exportGuards(input: AuthorityInput<"exportGuards">): Promise<AuthorityOutput<"exportGuards">>;
  recoverable(input: AuthorityInput<"recoverable">): Promise<AuthorityOutput<"recoverable">>;
}

export const resultOperations = {
  resultPut: {
    input: struct({
      workspace: dockerAttemptPlanSchema.fields.workspace,
      value: executionResultSchema,
    }),
    output: resultRefSchema,
  },
  resultGet: {
    input: struct({ workspace: dockerAttemptPlanSchema.fields.workspace, ref: resultRefSchema }),
    output: executionResultSchema,
  },
};

export const authorityCommandSchema = Schema.Union([
  struct({ operation: Schema.Literal("status"), input: authorityOperations.status.input }),
  struct({
    operation: Schema.Literal("openSession"),
    input: authorityOperations.openSession.input,
  }),
  struct({ operation: Schema.Literal("read"), input: authorityOperations.read.input }),
  struct({ operation: Schema.Literal("admit"), input: authorityOperations.admit.input }),
  struct({ operation: Schema.Literal("complete"), input: authorityOperations.complete.input }),
  struct({
    operation: Schema.Literal("beginExport"),
    input: authorityOperations.beginExport.input,
  }),
  struct({ operation: Schema.Literal("endExport"), input: authorityOperations.endExport.input }),
  struct({
    operation: Schema.Literal("exportGuards"),
    input: authorityOperations.exportGuards.input,
  }),
  struct({
    operation: Schema.Literal("recoverable"),
    input: authorityOperations.recoverable.input,
  }),
  struct({ operation: Schema.Literal("resultPut"), input: resultOperations.resultPut.input }),
  struct({ operation: Schema.Literal("resultGet"), input: resultOperations.resultGet.input }),
]);

export const authorityErrorSchema = struct({ error: authorityFailureSchema });

export type AuthorityCommand = Schema.Schema.Type<typeof authorityCommandSchema>;
