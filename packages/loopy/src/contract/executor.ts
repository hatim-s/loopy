import { z } from "zod";
import { commandNodeSchema, executionErrorSchema } from "./graph.js";
import { jsonSchema } from "./json.js";

export const attemptLogSchema = z.strictObject({ message: z.string(), data: jsonSchema });

export const executionResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("succeeded"),
    output: jsonSchema,
    logs: z.array(attemptLogSchema),
  }),
  z.strictObject({
    kind: z.literal("failed"),
    error: executionErrorSchema,
    exitCode: z.number().nullable(),
    logs: z.array(attemptLogSchema),
  }),
]);

const dictionary = z.record(z.string(), jsonSchema);

export const executionSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("code"),
    bundleHash: z.string(),
    input: dictionary,
    timeoutMs: z.number().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("command"),
    node: commandNodeSchema,
    argv: z.array(z.string()),
    flags: dictionary,
    cwd: z.string().nullable(),
    env: z.record(z.string(), z.string()),
    stdin: z.string().nullable(),
    parse: z.strictObject({ bundleHash: z.string(), input: dictionary }).nullable(),
  }),
]);

export type { AttemptLog, ExecutionError, ExecutionResult, ExecutionSpec } from "../core/index.js";
