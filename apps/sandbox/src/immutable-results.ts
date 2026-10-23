import { createHash, randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  SANDBOX_MAX_CAPTURE_BYTES,
  type SandboxExecutionResult,
  sandboxExecutionResultSchema,
} from "../../../packages/loopy/src/contract/index.js";
import type {
  ImmutableResults,
  ResultRef,
} from "../../../packages/loopy/src/contract/sandbox-journal.js";
import { canonicalJson } from "../../../packages/loopy/src/core/index.js";
import { readBytes, syncDirectory } from "./journal-files.js";

export function resultBytes(result: SandboxExecutionResult) {
  const bytes = Buffer.from(canonicalJson(result));

  if (bytes.byteLength > SANDBOX_MAX_CAPTURE_BYTES) {
    throw new Error("Sandbox terminal result exceeds its serialized byte limit.");
  }

  return bytes;
}

export function resultReference(result: SandboxExecutionResult): ResultRef {
  const bytes = resultBytes(result);

  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
}

export class FilesystemResults implements ImmutableResults {
  private readonly prefix: string;
  constructor(
    private readonly root: string,
    workspace: string,
  ) {
    this.prefix = createHash("sha256").update(workspace).digest("hex");
  }

  private path(ref: ResultRef) {
    return join(this.root, "results", `${this.prefix}-${ref.sha256}.json`);
  }

  async get(ref: ResultRef) {
    const bytes = await readBytes(this.path(ref));

    if (
      !bytes ||
      bytes.byteLength !== ref.size ||
      createHash("sha256").update(bytes).digest("hex") !== ref.sha256
    ) {
      throw new Error(
        "Sandbox result bytes are missing or do not match their immutable reference.",
      );
    }

    return sandboxExecutionResultSchema.parse(JSON.parse(bytes.toString("utf8")));
  }

  async put(result: SandboxExecutionResult) {
    const bytes = resultBytes(result);
    const ref = resultReference(result);
    const directory = join(this.root, "results");
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);

    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }

    try {
      await link(temporary, this.path(ref)).catch((cause: unknown) => {
        if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) {
          throw cause;
        }
      });
      await syncDirectory(directory);
      await this.get(ref);

      return ref;
    } finally {
      await unlink(temporary);
    }
  }
}
