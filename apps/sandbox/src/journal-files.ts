import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AttemptRecord, ExportRecord } from "@loopy/contract";
import { errnoCode } from "@loopy/core";

export async function syncDirectory(path: string) {
  const directory = await open(path, "r");

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function ignoreMissing(operation: Promise<void>) {
  await operation.catch((cause: unknown) => {
    if (errnoCode(cause) !== "ENOENT") {
      throw cause;
    }
  });
}

export async function readBytes(path: string, limit = 2 * 1024 * 1024) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      const stat = await file.stat();

      if (!stat.isFile() || stat.size > limit) {
        throw new Error(
          `Sandbox state file ${path} must be a regular file of at most ${limit} bytes.`,
        );
      }

      return await file.readFile();
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") {
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
    await ignoreMissing(unlink(temporary));
  }
}
