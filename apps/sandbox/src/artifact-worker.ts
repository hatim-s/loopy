import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Effect, Result } from "effect";
import {
  decodeBoundary,
  SANDBOX_MAX_ARTIFACT_BYTES,
  type SandboxArtifact,
  type SandboxArtifactRead,
  sandboxArtifactPathSchema,
} from "../../../packages/loopy/src/contract/index.js";
import { errnoCode } from "../../../packages/loopy/src/core/index.js";
import { ArtifactError } from "./artifact-error.js";
import { failure } from "./operations.js";

async function readArtifactFile(path: string): Promise<SandboxArtifact> {
  const directories = [];
  let file;

  try {
    let directory = await open(
      "/workspace",
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );

    directories.push(directory);
    const parts = path.split("/");
    const name = parts.pop();

    if (name === undefined) {
      throw new ArtifactError("invalid_request", "Supply an artifact file path.");
    }

    // Held directory descriptors pin every ancestor. O_NOFOLLOW prevents symlink substitution.
    for (const part of parts) {
      directory = await open(
        `/proc/self/fd/${directory.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      directories.push(directory);
    }

    file = await open(
      `/proc/self/fd/${directory.fd}/${name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await file.stat();

    if (!before.isFile()) {
      throw new ArtifactError(
        "invalid_request",
        "Artifact must be a regular file without symlinks.",
      );
    }

    if (before.size > SANDBOX_MAX_ARTIFACT_BYTES) {
      throw new ArtifactError("output_limit", "Artifact exceeds the 1 MiB byte limit.");
    }

    const buffer = Buffer.alloc(SANDBOX_MAX_ARTIFACT_BYTES + 1);
    let size = 0;

    while (size < buffer.byteLength) {
      const read = await file.read(buffer, size, buffer.byteLength - size, size);

      if (read.bytesRead === 0) {
        break;
      }

      size += read.bytesRead;
    }

    if (size > SANDBOX_MAX_ARTIFACT_BYTES) {
      throw new ArtifactError("output_limit", "Artifact exceeds the 1 MiB byte limit.");
    }

    const after = await file.stat();

    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      size !== after.size
    ) {
      throw new ArtifactError(
        "conflict",
        "Artifact changed during export. Export after the run is terminal.",
      );
    }

    const bytes = buffer.subarray(0, size);

    return {
      path,
      bytes: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size,
    };
  } finally {
    await file?.close();

    for (const directory of directories.reverse()) {
      await directory.close();
    }
  }
}

export function readArtifact(path: string) {
  return Effect.tryPromise({
    try: () => readArtifactFile(path),
    catch: (cause) => (cause instanceof ArtifactError ? cause : failure("artifact file", cause)),
  }).pipe(Effect.uninterruptible);
}

if (import.meta.main) {
  let response: SandboxArtifactRead;

  try {
    const path = decodeBoundary(sandboxArtifactPathSchema)(process.argv[2]);
    const read = await Effect.runPromise(readArtifact(path).pipe(Effect.result));

    if (Result.isFailure(read)) {
      throw read.failure instanceof ArtifactError
        ? read.failure
        : "cause" in read.failure
          ? read.failure.cause
          : read.failure;
    }

    response = { kind: "artifact", artifact: read.success };
  } catch (cause) {
    if (cause instanceof ArtifactError) {
      response = { kind: "error", error: { code: cause.code, message: cause.message } };
    } else {
      const missing = errnoCode(cause) === "ENOENT";
      response = {
        kind: "error",
        error: {
          code: missing ? "not_found" : "invalid_request",
          message: missing
            ? "Artifact file was not found."
            : "Artifact path must contain only real directories and a regular file without symlinks.",
        },
      };
    }
  }

  process.stdout.write(JSON.stringify(response));
}
