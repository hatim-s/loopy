import {
  EXECUTION_MODES,
  EXECUTOR_OPERATIONS,
  type ExecutorError,
  errorMessage,
  executionKeySchema,
  executionSpecSchema,
} from "@loopy/core";
import { Schema } from "effect";

export const workerOptionsSchema = Schema.Struct({
  home: Schema.String,
  workspace: Schema.String,
  mode: Schema.Literals(EXECUTION_MODES),
  secrets: Schema.Array(Schema.String),
});

export type WorkerOptions = typeof workerOptionsSchema.Type;

/** The daemon resolves bundle paths, so the worker never consults the registry. */
export const workerRequestSchema = Schema.Struct({
  options: Schema.Struct({
    ...workerOptionsSchema.fields,
    bundles: Schema.Record(Schema.String, Schema.String),
  }),
  key: executionKeySchema,
  attempt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  spec: executionSpecSchema,
});

export type WorkerRequest = typeof workerRequestSchema.Type;

/** Only the trusted worker writes this bounded stdout record. Author output is captured separately. */
const workerFailureSchema = Schema.Struct({
  kind: Schema.Literal("executor_error"),
  operation: Schema.Literals(EXECUTOR_OPERATIONS),
  message: Schema.String.check(Schema.isMaxLength(2000)),
});

type WorkerFailure = typeof workerFailureSchema.Type;

export function workerFailure(stdout: string): WorkerFailure | undefined {
  const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(workerFailureSchema))(
    stdout.trim(),
    { onExcessProperty: "error" },
  );

  return decoded._tag === "Success" ? decoded.value : undefined;
}

export function encodeWorkerFailure(error: ExecutorError): string {
  const failure: WorkerFailure = {
    kind: "executor_error",
    operation: error.operation,
    message: (error.diagnostic ?? errorMessage(error.cause)).slice(0, 2000),
  };

  return `${JSON.stringify(failure)}\n`;
}
