import type { SandboxError } from "@loopy/contract";
import { Data } from "effect";

export type SandboxErrorCode = SandboxError["error"]["code"];

export const statusFor = {
  unauthorized: 401,
  invalid_request: 400,
  conflict: 409,
  not_found: 404,
  output_limit: 413,
  internal: 500,
} as const satisfies Record<SandboxErrorCode, number>;

export class SandboxRequestError extends Data.TaggedError("SandboxRequestError")<{
  code: SandboxErrorCode;
  message: string;
}> {
  constructor(code: SandboxErrorCode, message: string) {
    super({ code, message });
  }
}

// Cleanup failure must win over any other failure from the same export request.
export class ExportCleanupError extends Data.TaggedError("ExportCleanupError")<{
  code: "conflict";
  cause: unknown;
  message: string;
}> {
  constructor(cause: unknown) {
    super({
      code: "conflict",
      cause,
      message: "Workspace export cleanup is unresolved. Retry after reconciliation.",
    });
  }
}
