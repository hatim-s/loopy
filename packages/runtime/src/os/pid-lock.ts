import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { errnoCode } from "@loopy/core";
import {
  processAlive,
  publishExclusive,
  readRegularFile,
  syncDirectory,
  writeExclusive,
} from "./fs";

const LOCK_BYTES = 1024;

export type PidLockAttempt =
  | { readonly kind: "acquired"; readonly release: () => void }
  | { readonly kind: "held"; readonly pid: number }
  | { readonly kind: "starting" };

function lockOwner(path: string) {
  const bytes = readRegularFile(path, LOCK_BYTES);

  if (bytes === null) {
    return null;
  }

  const [pid = "", nonce = ""] = bytes.toString("utf8").split(" ");

  if (!/^[1-9]\d*$/.test(pid) || !nonce) {
    throw new Error(`Lock file '${path}' is malformed. Inspect it before removing it.`);
  }

  return { pid: Number(pid), nonce };
}

/**
 * Takes a process lock file unless a live process holds it, reclaiming it from an owner that has
 * exited. A separate exclusive guard stops two starting processes from both reclaiming the same
 * dead owner, so a process that finds the guard taken reports "starting".
 */
export function tryPidLock(path: string): PidLockAttempt {
  const guard = `${path}.guard`;
  const nonce = crypto.randomUUID();

  try {
    writeExclusive(guard, String(process.pid), 0o600);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      return { kind: "starting" };
    }

    throw error;
  }

  try {
    const owner = lockOwner(path);

    if (owner !== null) {
      if (processAlive(owner.pid)) {
        return { kind: "held", pid: owner.pid };
      }

      rmSync(path);
    }

    // A linked file appears with its full contents, so a crash never leaves an ownerless lock.
    if (!publishExclusive(path, `${process.pid} ${nonce}`, 0o600)) {
      throw new Error(`Lock '${path}' appeared while its guard was held. Inspect its directory.`);
    }
  } finally {
    rmSync(guard, { force: true });
  }

  return {
    kind: "acquired",
    release: () => {
      if (lockOwner(path)?.nonce !== nonce) {
        throw new Error(`Lock '${path}' changed owner. Leave it intact and inspect its directory.`);
      }

      rmSync(path);
      syncDirectory(dirname(path));
    },
  };
}

/** Takes a process lock file or explains which process to stop first. */
export function acquirePidLock(path: string): () => void {
  const attempt = tryPidLock(path);

  switch (attempt.kind) {
    case "acquired":
      return attempt.release;
    case "held":
      throw new Error(`Process ${attempt.pid} holds '${path}'. Stop it before starting another.`);
    case "starting":
      throw new Error(
        `Lock guard '${path}.guard' is held. Verify no process is starting, then remove the guard.`,
      );
  }
}
