import { Schema } from "effect";
import { EXECUTION_ERROR_CODES } from "../core";
import { struct } from "./codec";

import { hashSchema } from "./compiled-loopy";
import { executionKeySchema, nodeSchema } from "./graph";
import { jsonSchema } from "./json";

export const SANDBOX_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export const SANDBOX_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export const SANDBOX_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

const dictionary = Schema.Record(Schema.String, Schema.mutableKey(jsonSchema));

const commandNodeSchema = nodeSchema.members[1];

export const sandboxExecutionSpecSchema = Schema.Union([
  struct({
    kind: Schema.Literal("code"),
    bundleHash: hashSchema,
    input: dictionary,
    timeoutMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  struct({
    kind: Schema.Literal("command"),
    node: commandNodeSchema,
    argv: Schema.Array(Schema.String).pipe(Schema.mutable).check(Schema.isMinLength(1)),
    flags: dictionary,
    cwd: Schema.NullOr(Schema.String),
    env: Schema.Record(Schema.String, Schema.mutableKey(Schema.String)),
    stdin: Schema.NullOr(Schema.String),
    parse: Schema.NullOr(struct({ bundleHash: hashSchema, input: dictionary })),
  }),
]);

const logSchema = struct({ message: Schema.String, data: jsonSchema });

export const sandboxExecutionResultSchema = Schema.Union([
  struct({
    kind: Schema.Literal("succeeded"),
    output: jsonSchema,
    logs: Schema.Array(logSchema).pipe(Schema.mutable),
  }),
  struct({
    kind: Schema.Literal("failed"),
    error: struct({ code: Schema.Literals(EXECUTION_ERROR_CODES), message: Schema.String }),
    exitCode: Schema.NullOr(Schema.Int),
    logs: Schema.Array(logSchema).pipe(Schema.mutable),
  }),
]);

export const sandboxReceiptSchema = Schema.Union([
  struct({ kind: Schema.Literal("none") }),
  struct({ kind: Schema.Literal("started") }),
  struct({ kind: Schema.Literal("finished"), result: sandboxExecutionResultSchema }),
]);

export const sandboxAttemptIdentitySchema = struct({
  workspace: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(256)),
  executionKey: executionKeySchema,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const sandboxAttemptRequestSchema = struct({
  ...sandboxAttemptIdentitySchema.fields,
  spec: sandboxExecutionSpecSchema,
  bundles: Schema.Array(
    struct({
      hash: hashSchema,
      bytes: Schema.String.check(
        Schema.isMaxLength(Math.ceil(SANDBOX_MAX_BUNDLE_BYTES / 3) * 4),
      ).check(Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)),
    }),
  )
    .pipe(Schema.mutable)
    .check(Schema.isMaxLength(2)),
});

export const sandboxErrorSchema = struct({
  error: struct({
    code: Schema.Literals([
      "unauthorized",
      "invalid_request",
      "conflict",
      "not_found",
      "output_limit",
      "internal",
    ]),
    message: Schema.String,
  }),
});

export type SandboxExecutionSpec = Schema.Schema.Type<typeof sandboxExecutionSpecSchema>;

export type SandboxExecutionResult = Schema.Schema.Type<typeof sandboxExecutionResultSchema>;

export type SandboxReceipt = Schema.Schema.Type<typeof sandboxReceiptSchema>;

export type SandboxAttemptIdentity = Schema.Schema.Type<typeof sandboxAttemptIdentitySchema>;

export type SandboxAttemptRequest = Schema.Schema.Type<typeof sandboxAttemptRequestSchema>;

export type SandboxError = Schema.Schema.Type<typeof sandboxErrorSchema>;

export const SANDBOX_MAX_ARTIFACT_BYTES = 1024 * 1024;

export const sandboxArtifactPathSchema = Schema.String.check(Schema.isMinLength(1))
  .check(Schema.isMaxLength(1024))
  .check(
    Schema.makeFilter(
      (path) =>
        !/[\\:\u0000-\u001f\u007f]/.test(path) &&
        path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      { message: "Supply a relative file path without traversal or empty path components." },
    ),
  );

export const sandboxArtifactRequestSchema = struct({
  ...sandboxAttemptIdentitySchema.fields,
  path: sandboxArtifactPathSchema,
});

export const sandboxArtifactSchema = struct({
  path: sandboxArtifactPathSchema,
  bytes: Schema.String.check(
    Schema.isMaxLength(Math.ceil(SANDBOX_MAX_ARTIFACT_BYTES / 3) * 4),
  ).check(Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)),
  sha256: hashSchema,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(SANDBOX_MAX_ARTIFACT_BYTES),
  ),
});

export const sandboxArtifactReadSchema = Schema.Union([
  struct({ kind: Schema.Literal("artifact"), artifact: sandboxArtifactSchema }),
  struct({ kind: Schema.Literal("error"), error: sandboxErrorSchema.fields.error }),
]);

export type SandboxArtifactRequest = Schema.Schema.Type<typeof sandboxArtifactRequestSchema>;

export type SandboxArtifact = Schema.Schema.Type<typeof sandboxArtifactSchema>;

export type SandboxArtifactRead = Schema.Schema.Type<typeof sandboxArtifactReadSchema>;
