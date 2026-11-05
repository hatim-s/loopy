import { Effect, Schema } from "effect";
import { executionKeySchema, jsonSchema, nodeSchema } from "../contract/index.js";
import { EXECUTION_MODES } from "../core/index.js";
import { ExecutionWorker } from "./execution.js";
import { FilesystemReceipts, filesystemReceiptsDescriptorSchema } from "./receipts.js";
import { encodeWorkerFailure } from "./response.js";

const dictionary = Schema.Record(Schema.String, jsonSchema);

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
  spec: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("code"),
      bundleHash: Schema.String,
      input: dictionary,
      timeoutMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
    Schema.Struct({
      kind: Schema.Literal("command"),
      node: nodeSchema,
      argv: Schema.mutable(Schema.Array(Schema.String)),
      flags: dictionary,
      cwd: Schema.NullOr(Schema.String),
      env: Schema.Record(Schema.String, Schema.String),
      stdin: Schema.NullOr(Schema.String),
      parse: Schema.NullOr(Schema.Struct({ bundleHash: Schema.String, input: dictionary })),
    }),
  ]),
});

const request = Schema.decodeUnknownSync(requestSchema)(await Bun.stdin.json(), {
  onExcessProperty: "error",
});

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

const execute =
  request.spec.kind === "code"
    ? executor.execute(request.key, request.attempt, request.spec, controller.signal)
    : request.spec.node.kind === "command"
      ? executor.execute(
          request.key,
          request.attempt,
          { ...request.spec, node: request.spec.node },
          controller.signal,
        )
      : Effect.die(new Error("Execution requires a command node."));

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
