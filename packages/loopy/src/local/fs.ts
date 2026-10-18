import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { errnoCode } from "../core/index.js";

/** The `code` of a Node filesystem error, or undefined for anything else. */
export { errnoCode } from "../core/index.js";

/** Canonical path for ownership checks: symlinks resolve, missing files stay absolute. */
export function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

/**
 * Serialises writers with a lock directory, since mkdir is atomic on every
 * filesystem. `holder` names the kind of work in the busy message.
 */
export async function withLockDirectory<T>(
  lock: string,
  holder: string,
  work: () => T | Promise<T>,
): Promise<T> {
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
    return await work();
  } finally {
    rmSync(lock, { recursive: true });
  }
}
