import type { SandboxError } from "../../../packages/loopy/src/contract/index.js";

export class ArtifactError extends Error {
  constructor(
    readonly code: SandboxError["error"]["code"],
    message: string,
  ) {
    super(message);
  }
}
