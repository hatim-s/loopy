import { Data } from "effect";
import type { SandboxError } from "../../../packages/loopy/src/contract/index.js";

export class ArtifactError extends Data.TaggedError("ArtifactError")<{
  code: SandboxError["error"]["code"];
  message: string;
}> {
  constructor(code: SandboxError["error"]["code"], message: string) {
    super({ code, message });
  }
}

export class ExportCleanupError extends Data.TaggedError("ExportCleanupError")<{
  cause: unknown;
  message: string;
  code: "conflict";
}> {
  constructor(cause: unknown) {
    super({
      cause,
      code: "conflict",
      message: "Workspace export cleanup is unresolved. Retry after reconciliation.",
    });
  }
}
