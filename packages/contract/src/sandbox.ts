import {
  counter,
  executionKeySchema,
  executionSpecSchema,
  hashSchema,
  positiveInt,
  struct,
} from "@loopy/core";
import { Schema } from "effect";
import { boundedBase64, boundedToken } from "./codec";

export const SANDBOX_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export const SANDBOX_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export const SANDBOX_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export const sandboxAttemptIdentitySchema = struct({
  workspace: boundedToken,
  executionKey: executionKeySchema,
  attempt: positiveInt,
});

export const sandboxAttemptRequestSchema = struct({
  ...sandboxAttemptIdentitySchema.fields,
  spec: executionSpecSchema,
  bundles: Schema.Array(
    struct({ hash: hashSchema, bytes: boundedBase64(SANDBOX_MAX_BUNDLE_BYTES) }),
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
  bytes: boundedBase64(SANDBOX_MAX_ARTIFACT_BYTES),
  sha256: hashSchema,
  size: counter.check(Schema.isLessThanOrEqualTo(SANDBOX_MAX_ARTIFACT_BYTES)),
});

export const sandboxArtifactReadSchema = Schema.Union([
  struct({ kind: Schema.Literal("artifact"), artifact: sandboxArtifactSchema }),
  struct({ kind: Schema.Literal("error"), error: sandboxErrorSchema.fields.error }),
]);

export type SandboxArtifactRequest = Schema.Schema.Type<typeof sandboxArtifactRequestSchema>;

export type SandboxArtifact = Schema.Schema.Type<typeof sandboxArtifactSchema>;

export type SandboxArtifactRead = Schema.Schema.Type<typeof sandboxArtifactReadSchema>;
