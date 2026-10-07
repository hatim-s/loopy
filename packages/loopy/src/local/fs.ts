import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isRecord } from "../core/index.js";

/** The `code` of a Node filesystem error, or undefined for anything else. */
export function errnoCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

/** Canonical path for ownership checks: symlinks resolve, missing files stay absolute. */
export function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

/**
 * Serialises writers with a lock directory, since mkdir is atomic on every
 * filesystem. `holder` names the kind of work in the busy message.
 */
export function withLockDirectory<T>(lock: string, holder: string, work: () => T): T {
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      throw new Error(
        `Another ${holder} holds '${lock}'. If its process stopped, remove that lock directory and retry.`,
      );
    }
    throw error;
  }
  try {
    return work();
  } finally {
    rmSync(lock, { recursive: true });
  }
}

/** Writes through a sibling temp file so a reader sees the old or the new content, never half. */
export function writeFileAtomically(file: string, text: string, mode: number): void {
  const temporary = join(dirname(file), `.${basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    chmodSync(file, mode);
  } finally {
    rmSync(temporary, { force: true });
  }
}
