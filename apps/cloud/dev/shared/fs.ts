import { lstat } from "node:fs/promises";
import { errnoCode } from "@loopy/core";
import { publishExclusive } from "@loopy/runtime/os";

// Only a missing path counts as absent; permission and I/O errors must surface.

export async function lstatOrAbsent(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") {
      return undefined;
    }

    throw cause;
  }
}

/** A catch handler that names a missing path with `message` and rethrows every other error. */
export function whenMissing(message: string) {
  return (cause: unknown): never => {
    throw errnoCode(cause) === "ENOENT" ? new Error(message) : cause;
  };
}

/** Publishes complete, synced bytes at a new path. A path that already exists fails with `exists`. */
export function createOnce(
  path: string,
  contents: string | Uint8Array,
  mode: number,
  exists: string,
) {
  if (!publishExclusive(path, contents, mode)) {
    throw new Error(exists);
  }
}
