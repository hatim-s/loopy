import {
  counter,
  executionResultSchema,
  hashSchema,
  PAGE_LIMIT,
  positiveInt,
  struct,
} from "@loopy/core";
import { Record as EffectRecord, Schema } from "effect";
import { boundedToken } from "../codec";
import {
  attemptRecordSchema,
  authorityFailureSchema,
  authoritySessionSchema,
  dockerAttemptPlanSchema,
  exportRecordSchema,
  finishedAttemptRecordSchema,
  resultRefSchema,
  startedAttemptRecordSchema,
} from "./journal";

const rejected = struct({ kind: Schema.Literal("rejected"), code: authorityFailureSchema });

const session = { session: authoritySessionSchema };

export const authorityOperations = {
  status: {
    // An empty Struct accepts any object fields; status takes none.
    input: Schema.Record(Schema.String, Schema.Never),
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
      // Cursors name an attempt id (`a:`) or an export token (`e:`).
      after: Schema.NullOr(
        Schema.String.check(Schema.isPattern(/^[ae]:/)).check(Schema.isMaxLength(258)),
      ),
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

const operations = { ...authorityOperations, ...resultOperations };

export type OperationName = keyof typeof operations;

export type OperationInput<K extends OperationName> = Schema.Schema.Type<
  (typeof operations)[K]["input"]
>;

export type OperationOutput<K extends OperationName> = Schema.Schema.Type<
  (typeof operations)[K]["output"]
>;

export function operationOutput<K extends OperationName>(
  operation: K,
): (typeof operations)[K]["output"] {
  return operations[operation].output;
}

type CommandSchema<K extends OperationName> = Schema.Struct<{
  operation: Schema.Literal<K>;
  input: (typeof operations)[K]["input"];
}>;

const commandSchema = <K extends OperationName>(operation: K): CommandSchema<K> =>
  Schema.Struct({ operation: Schema.Literal(operation), input: operations[operation].input });

export const authorityCommandSchema = Schema.Union(
  // SAFETY: commandSchema pairs each operation literal with that operation's own input schema.
  EffectRecord.keys(operations).map(commandSchema) as {
    [K in OperationName]: CommandSchema<K>;
  }[OperationName][],
);

/** Correlates each operation with its input so one handler table can serve every command. */
export type AuthorityCommand<K extends OperationName = OperationName> = {
  [P in K]: { readonly operation: P; readonly input: OperationInput<P> };
}[K];

export const authorityErrorSchema = struct({ error: authorityFailureSchema });
