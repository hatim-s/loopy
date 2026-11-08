import { Data, type Effect, Schema } from "effect";
import { hashSchema, positiveInt, struct } from "./codec";
import type { ExecutionKey } from "./graph/key";
import { commandFlagSpecSchema, commandVariantsSchema } from "./graph/nodes";
import { jsonSchema } from "./json";

const dictionary = Schema.Record(Schema.String, Schema.mutableKey(jsonSchema));

const timeoutMs = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Commands without a declared timeout and every parser get this budget. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** Commands without a declared output cap and every code bundle may capture this much. */
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

// Covers worker startup, bundle staging and receipt publication around the attempt's own budget.
const ATTEMPT_GRACE_MS = 30_000;

/** Every setting is resolved, so executors never read graph nodes. */
export const executionSpecSchema = Schema.Union([
  struct({
    kind: Schema.Literal("code"),
    bundleHash: hashSchema,
    input: dictionary,
    timeoutMs,
  }),
  struct({
    kind: Schema.Literal("command"),
    key: Schema.String,
    argv: Schema.NonEmptyArray(Schema.String).pipe(Schema.mutable),
    flags: dictionary,
    flagSpec: Schema.NullOr(commandFlagSpecSchema),
    variants: commandVariantsSchema,
    cwd: Schema.NullOr(Schema.String),
    env: Schema.Record(Schema.String, Schema.mutableKey(Schema.String)),
    stdin: Schema.NullOr(Schema.String),
    timeoutMs,
    maxOutputBytes: positiveInt,
    okExitCodes: Schema.Array(Schema.Int).pipe(Schema.mutable),
    parse: Schema.NullOr(struct({ bundleHash: hashSchema, timeoutMs })),
  }),
]);

export type ExecutionSpec = Schema.Schema.Type<typeof executionSpecSchema>;

export type CommandSpec = Extract<ExecutionSpec, { kind: "command" }>;

/** The outer deadline a host gives one attempt, shared by the local worker and sandbox admission. */
export function attemptBudgetMs(spec: ExecutionSpec): number {
  const parse = spec.kind === "command" && spec.parse !== null ? spec.parse.timeoutMs : 0;

  return spec.timeoutMs + parse + ATTEMPT_GRACE_MS;
}

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
  /** Idempotent per attempt: returns a finished result and waits for a started attempt to finish. */
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
