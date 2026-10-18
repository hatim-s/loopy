import { z } from "zod";
import { executionKeySchema, executionSpecSchema } from "../contract/index.js";
import { EXECUTION_MODES } from "../core/index.js";
import { ExecutionWorker } from "./execution.js";

const requestSchema = z.object({
  options: z.object({
    home: z.string(),
    workspace: z.string(),
    mode: z.enum(EXECUTION_MODES),
    secrets: z.record(z.string(), z.string()),
    bundles: z.record(z.string(), z.string()),
  }),
  key: executionKeySchema,
  attempt: z.number().int().positive(),
  spec: executionSpecSchema,
});

const request = requestSchema.parse(await Bun.stdin.json());

const controller = new AbortController();

process.on("SIGTERM", () => controller.abort());

process.on("SIGINT", () => controller.abort());

const executor = new ExecutionWorker({
  ...request.options,
  bundlePath: (hash) => {
    const path = request.options.bundles[hash];

    if (!path) {
      throw new Error("Execution bundle was not supplied.");
    }

    return path;
  },
});

await executor.execute(request.key, request.attempt, request.spec, controller.signal);
