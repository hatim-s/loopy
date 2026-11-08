import { executionKeySchema, executionSpecSchema } from "@loopy/contract";
import { Effect, Schema } from "effect";
import { LocalExecutor } from "../../src/executor";

// A caller process that starts one execution, so a test can kill the caller and keep its worker.
const request = Schema.decodeUnknownSync(
  Schema.Struct({
    home: Schema.String,
    workspace: Schema.String,
    bundle: Schema.String,
    key: executionKeySchema,
    spec: executionSpecSchema,
  }),
)(await Bun.stdin.json());

const executor = new LocalExecutor({
  home: request.home,
  workspace: request.workspace,
  mode: "sandbox",
  secrets: [],
  bundlePath: () => request.bundle,
});

await Effect.runPromise(
  executor.execute(request.key, 1, request.spec, new AbortController().signal),
);
