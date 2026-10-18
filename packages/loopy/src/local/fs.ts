import { mkdirSync, rmSync } from "node:fs";
import { errnoCode } from "../core/index.js";

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
