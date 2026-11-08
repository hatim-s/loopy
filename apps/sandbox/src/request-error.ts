import type { SandboxErrorCode } from "@loopy/contract/sandbox";
import { Data } from "effect";

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
