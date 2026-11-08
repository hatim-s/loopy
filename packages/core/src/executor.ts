import { Data, type Effect, Schema } from "effect";
import { hashSchema, struct } from "./codec";
import type { ExecutionKey } from "./graph/key";
import { commandNodeSchema } from "./graph/nodes";
import { jsonSchema } from "./json";

const dictionary = Schema.Record(Schema.String, Schema.mutableKey(jsonSchema));

export const executionSpecSchema = Schema.Union([
  struct({
    kind: Schema.Literal("code"),
    bundleHash: hashSchema,
    input: dictionary,
    timeoutMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  struct({
    kind: Schema.Literal("command"),
    node: commandNodeSchema,
    argv: Schema.Array(Schema.String).pipe(Schema.mutable).check(Schema.isMinLength(1)),
    flags: dictionary,
    cwd: Schema.NullOr(Schema.String),
    env: Schema.Record(Schema.String, Schema.mutableKey(Schema.String)),
    stdin: Schema.NullOr(Schema.String),
    parse: Schema.NullOr(struct({ bundleHash: hashSchema, input: dictionary })),
  }),
]);

export type ExecutionSpec = Schema.Schema.Type<typeof executionSpecSchema>;

export const EXECUTION_ERROR_CODES = [
  "execution",
  "exit",
  "protocol",
  "validation",
  "output_limit",
  "uncertain",
] as const;

export const executionErrorSchema = struct({
  code: Schema.Literals(EXECUTION_ERROR_CODES),
  message: Schema.String,
});

export type ExecutionError = Schema.Schema.Type<typeof executionErrorSchema>;

export const attemptLogSchema = struct({ message: Schema.String, data: jsonSchema });

export type AttemptLog = Schema.Schema.Type<typeof attemptLogSchema>;

const logs = Schema.Array(attemptLogSchema).pipe(Schema.mutable);

export const executionResultSchema = Schema.Union([
  struct({ kind: Schema.Literal("succeeded"), output: jsonSchema, logs }),
  struct({
    kind: Schema.Literal("failed"),
    error: executionErrorSchema,
    exitCode: Schema.NullOr(Schema.Int),
    logs,
  }),
]);

export type ExecutionResult = Schema.Schema.Type<typeof executionResultSchema>;

export const receiptSchema = Schema.Union([
  struct({ kind: Schema.Literal("none") }),
  struct({ kind: Schema.Literal("started") }),
  struct({ kind: Schema.Literal("finished"), result: executionResultSchema }),
]);

export type Receipt = Schema.Schema.Type<typeof receiptSchema>;

export interface Executor {
  execute(
    executionKey: ExecutionKey,
    attempt: number,
    spec: ExecutionSpec,
    signal: AbortSignal,
  ): Effect.Effect<ExecutionResult, ExecutorError>;
  lookup(executionKey: ExecutionKey, attempt: number): Effect.Effect<Receipt, ExecutorError>;
}

export const EXECUTOR_OPERATIONS = ["receipt", "lookup", "execute", "secret"] as const;

/** Infrastructure failures never become durable node failures. Reconcile started work before retrying. */
export class ExecutorError extends Data.TaggedError("ExecutorError")<{
  operation: (typeof EXECUTOR_OPERATIONS)[number];
  cause: unknown;
  diagnostic?: string;
}> {}
