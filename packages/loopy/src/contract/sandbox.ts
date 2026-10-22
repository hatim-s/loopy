import { z } from "zod";
import { EXECUTION_ERROR_CODES } from "../core/index.js";
import { hashSchema } from "./compiled-loopy.js";
import { executionKeySchema, nodeSchema } from "./graph.js";
import { jsonSchema } from "./json.js";

export const SANDBOX_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export const SANDBOX_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export const SANDBOX_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

const dictionary = z.record(z.string(), jsonSchema);

const commandNodeSchema = nodeSchema.options[1];

export const sandboxExecutionSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("code"),
    bundleHash: hashSchema,
    input: dictionary,
    timeoutMs: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("command"),
    node: commandNodeSchema,
    argv: z.array(z.string()).min(1),
    flags: dictionary,
    cwd: z.string().nullable(),
    env: z.record(z.string(), z.string()),
    stdin: z.string().nullable(),
    parse: z.strictObject({ bundleHash: hashSchema, input: dictionary }).nullable(),
  }),
]);

const logSchema = z.strictObject({ message: z.string(), data: jsonSchema });

export const sandboxExecutionResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("succeeded"), output: jsonSchema, logs: z.array(logSchema) }),
  z.strictObject({
    kind: z.literal("failed"),
    error: z.strictObject({ code: z.enum(EXECUTION_ERROR_CODES), message: z.string() }),
    exitCode: z.number().int().nullable(),
    logs: z.array(logSchema),
  }),
]);

export const sandboxReceiptSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("started") }),
  z.strictObject({ kind: z.literal("finished"), result: sandboxExecutionResultSchema }),
]);

export const sandboxAttemptIdentitySchema = z.strictObject({
  workspace: z.string().min(1).max(256),
  executionKey: executionKeySchema,
  attempt: z.number().int().positive(),
});

export const sandboxAttemptRequestSchema = sandboxAttemptIdentitySchema.extend({
  spec: sandboxExecutionSpecSchema,
  bundles: z
    .array(
      z.strictObject({
        hash: hashSchema,
        bytes: z
          .string()
          .max(Math.ceil(SANDBOX_MAX_BUNDLE_BYTES / 3) * 4)
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      }),
    )
    .max(2),
});

export const sandboxErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      "unauthorized",
      "invalid_request",
      "conflict",
      "not_found",
      "output_limit",
      "internal",
    ]),
    message: z.string(),
  }),
});

export type SandboxExecutionSpec = z.infer<typeof sandboxExecutionSpecSchema>;

export type SandboxExecutionResult = z.infer<typeof sandboxExecutionResultSchema>;

export type SandboxReceipt = z.infer<typeof sandboxReceiptSchema>;

export type SandboxAttemptIdentity = z.infer<typeof sandboxAttemptIdentitySchema>;

export type SandboxAttemptRequest = z.infer<typeof sandboxAttemptRequestSchema>;

export type SandboxError = z.infer<typeof sandboxErrorSchema>;

export const SANDBOX_MAX_ARTIFACT_BYTES = 1024 * 1024;

export const sandboxArtifactPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !/[\\:\u0000-\u001f\u007f]/.test(path) &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Supply a relative file path without traversal or empty path components.",
  );

export const sandboxArtifactRequestSchema = sandboxAttemptIdentitySchema.extend({
  path: sandboxArtifactPathSchema,
});

export const sandboxArtifactSchema = z.strictObject({
  path: sandboxArtifactPathSchema,
  bytes: z
    .string()
    .max(Math.ceil(SANDBOX_MAX_ARTIFACT_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  sha256: hashSchema,
  size: z.number().int().min(0).max(SANDBOX_MAX_ARTIFACT_BYTES),
});

export const sandboxArtifactReadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("artifact"), artifact: sandboxArtifactSchema }),
  z.strictObject({ kind: z.literal("error"), error: sandboxErrorSchema.shape.error }),
]);

export type SandboxArtifactRequest = z.infer<typeof sandboxArtifactRequestSchema>;

export type SandboxArtifact = z.infer<typeof sandboxArtifactSchema>;

export type SandboxArtifactRead = z.infer<typeof sandboxArtifactReadSchema>;
