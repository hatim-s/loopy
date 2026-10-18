import { z } from "zod";
import { executionKeySchema, jsonSchema, nodeSchema } from "../contract/index.js";
import { EXECUTION_MODES } from "../core/index.js";
import { ExecutionWorker } from "./execution.js";

const dictionary = z.record(z.string(), jsonSchema);

const requestSchema = z.object({
  options: z.object({
    home: z.string(),
    workspace: z.string(),
    mode: z.enum(EXECUTION_MODES),
    secrets: z.array(z.string()),
    bundles: z.record(z.string(), z.string()),
  }),
  key: executionKeySchema,
  attempt: z.number().int().positive(),
  spec: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("code"),
      bundleHash: z.string(),
      input: dictionary,
      timeoutMs: z.number().nonnegative(),
    }),
    z.object({
      kind: z.literal("command"),
      node: nodeSchema,
      argv: z.array(z.string()),
      flags: dictionary,
      cwd: z.string().nullable(),
      env: z.record(z.string(), z.string()),
      stdin: z.string().nullable(),
      parse: z.object({ bundleHash: z.string(), input: dictionary }).nullable(),
    }),
  ]),
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

if (request.spec.kind === "code") {
  await executor.execute(request.key, request.attempt, request.spec, controller.signal);
} else if (request.spec.node.kind === "command") {
  await executor.execute(
    request.key,
    request.attempt,
    { ...request.spec, node: request.spec.node },
    controller.signal,
  );
} else {
  throw new Error("Execution requires a command node.");
}
