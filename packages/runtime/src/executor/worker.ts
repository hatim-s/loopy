import { decodeBoundary } from "@loopy/contract";
import { EXECUTION_MODES, executionKeySchema, executionSpecSchema } from "@loopy/core";
import { Effect, Schema } from "effect";
import { ExecutionWorker } from "./execution";
import { FilesystemReceipts, filesystemReceiptsDescriptorSchema } from "./receipts";
import { encodeWorkerFailure } from "./response";

const requestSchema = Schema.Struct({
  options: Schema.Struct({
    home: Schema.String,
    receipts: filesystemReceiptsDescriptorSchema,
    workspace: Schema.String,
    mode: Schema.Literals(EXECUTION_MODES),
    secrets: Schema.Array(Schema.String),
    bundles: Schema.Record(Schema.String, Schema.String),
  }),
  key: executionKeySchema,
  attempt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  spec: executionSpecSchema,
});

const request = decodeBoundary(requestSchema)(await Bun.stdin.json());

const controller = new AbortController();

process.on("SIGTERM", () => controller.abort());

process.on("SIGINT", () => controller.abort());

if (request.options.receipts.home !== request.options.home) {
  throw new Error("Execution receipts must use the protected daemon home.");
}

const executor = new ExecutionWorker({
  ...request.options,
  receipts: new FilesystemReceipts(request.options.receipts.home),
  bundlePath: (hash) => {
    const path = request.options.bundles[hash];

    if (!path) {
      throw new Error("Execution bundle was not supplied.");
    }

    return path;
  },
});

const execute = executor.execute(request.key, request.attempt, request.spec, controller.signal);

await Effect.runPromise(
  execute.pipe(
    Effect.catchTag("ExecutorError", (error) =>
      Effect.sync(() => {
        // Transport private diagnostics only. Never put Causes or secret values in a domain receipt.
        process.stdout.write(encodeWorkerFailure(error));
        process.exitCode = 1;
      }),
    ),
  ),
);
