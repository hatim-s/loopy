import { Schema } from "effect";
import { EXECUTOR_OPERATIONS, type ExecutorError, errorMessage } from "../core/index.js";

/** Only the trusted worker writes this bounded stdout record. Author output is captured separately. */
export const workerFailureSchema = Schema.Struct({
  kind: Schema.Literal("executor_error"),
  operation: Schema.Literals(EXECUTOR_OPERATIONS),
  message: Schema.String.check(Schema.isMaxLength(2000)),
});

export type WorkerFailure = typeof workerFailureSchema.Type;

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
