import {
  counter,
  DEFAULT_MAX_OUTPUT_BYTES,
  executionKeySchema,
  executionSpecSchema,
  hashSchema,
  positiveInt,
  struct,
} from "@loopy/core";
import { Schema } from "effect";
import { boundedBase64, boundedToken, queryNumber } from "../codec";

export const SANDBOX_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export const SANDBOX_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

// The sandbox captures as much as the local host lets a command or bundle without a declared cap.
export const SANDBOX_MAX_CAPTURE_BYTES = DEFAULT_MAX_OUTPUT_BYTES;

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

const SANDBOX_ERROR_CODES = [
  "unauthorized",
  "invalid_request",
  "too_large",
  "conflict",
  "not_found",
  "output_limit",
  "internal",
] as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

export const sandboxErrorStatus = {
  unauthorized: 401,
  invalid_request: 400,
  too_large: 413,
  conflict: 409,
  not_found: 404,
  output_limit: 413,
  internal: 500,
} as const satisfies Record<SandboxErrorCode, number>;

export const sandboxErrorSchema = struct({
  error: struct({ code: Schema.Literals(SANDBOX_ERROR_CODES), message: Schema.String }),
});

export type SandboxAttemptIdentity = Schema.Schema.Type<typeof sandboxAttemptIdentitySchema>;

export type SandboxAttemptRequest = Schema.Schema.Type<typeof sandboxAttemptRequestSchema>;

export type SandboxError = Schema.Schema.Type<typeof sandboxErrorSchema>;

export const SANDBOX_MAX_ARTIFACT_BYTES = 1024 * 1024;

// Base64 text plus room for the path, digest and size around it.
export const SANDBOX_MAX_ARTIFACT_RESPONSE_BYTES =
  Math.ceil(SANDBOX_MAX_ARTIFACT_BYTES / 3) * 4 + 4096;

// A receipt carries one captured result. JSON escaping can at most double its bytes.
export const SANDBOX_MAX_RECEIPT_RESPONSE_BYTES = 2 * SANDBOX_MAX_CAPTURE_BYTES;

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

// Query values are text. The execution key travels as JSON under `key`.
const identityQueryFields = {
  executionKey: Schema.fromJsonString(executionKeySchema),
  attempt: queryNumber.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
};

/** `GET /attempts` on the sandbox. */
export const sandboxAttemptQuerySchema = struct({
  workspace: boundedToken,
  ...identityQueryFields,
}).pipe(Schema.encodeKeys({ executionKey: "key" }));

/** `GET /artifacts` on the sandbox. */
export const sandboxArtifactQuerySchema = struct({
  workspace: boundedToken,
  ...identityQueryFields,
  path: sandboxArtifactPathSchema,
}).pipe(Schema.encodeKeys({ executionKey: "key" }));

/** `GET /api/cloud/artifacts`, where the credential supplies the workspace. */
export const cloudArtifactQuerySchema = struct({
  ...identityQueryFields,
  path: sandboxArtifactPathSchema,
}).pipe(Schema.encodeKeys({ executionKey: "key" }));

/** Encodes a typed query into the search form its schema decodes. */
export function searchParams<S extends Schema.Codec<unknown, Readonly<Record<string, unknown>>>>(
  schema: S,
  value: S["Type"],
) {
  return new URLSearchParams(
    Object.entries(Schema.encodeSync(schema)(value)).map(([key, item]) => [key, String(item)]),
  );
}
