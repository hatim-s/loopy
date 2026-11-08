import { decodeBoundary } from "@loopy/contract";
import { Effect } from "effect";
import { ExecutionWorker } from "./execution";
import { encodeWorkerFailure, workerRequestSchema } from "./worker-protocol";

const request = decodeBoundary(workerRequestSchema)(await Bun.stdin.json());

const controller = new AbortController();

process.on("SIGTERM", () => controller.abort());

process.on("SIGINT", () => controller.abort());

const execute = new ExecutionWorker(request.options).execute(
  request.key,
  request.attempt,
  request.spec,
  controller.signal,
);

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
