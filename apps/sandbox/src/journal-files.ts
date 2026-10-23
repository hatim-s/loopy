import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AttemptRecord,
  ExportRecord,
} from "../../../packages/loopy/src/contract/sandbox-journal.js";

export async function syncDirectory(path: string) {
  const directory = await open(path, "r");

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export function missing(cause: unknown) {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

export async function readBytes(path: string, limit = 2 * 1024 * 1024) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      const stat = await file.stat();

      if (!stat.isFile() || stat.size > limit) {
        throw new Error("Sandbox journal requires a bounded regular file.");
      }

      return await file.readFile();
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (missing(cause)) {
      return null;
    }

    throw cause;
  }
}

export async function writeAtomic(path: string, value: AttemptRecord | ExportRecord) {
  const temporary = join(dirname(path), `${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);

  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }

  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch((cause: unknown) => {
      if (!missing(cause)) {
        throw cause;
      }
    });
  }
}
