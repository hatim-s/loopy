import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { decodeBoundary } from "@loopy/contract";
import { struct } from "@loopy/contract/codec";
import { errnoCode } from "@loopy/core";
import { Schema } from "effect";
import type { SandboxConfig } from "./config";
import { readBytes, syncDirectory } from "./journal-files";

export function stateLayout(root: string) {
  return {
    receipts: join(root, "receipts"),
    staging: join(root, "staging"),
    exports: join(root, "exports"),
    results: join(root, "results"),
    lock: join(root, "service.lock"),
    startGuard: join(root, "service-start.lock"),
  };
}

export async function validateStateRoot(config: Pick<SandboxConfig, "worktree" | "stateRoot">) {
  const worktree = resolve(config.worktree);

  if ((await realpath(worktree)) !== worktree) {
    throw new Error("Worktree must use its real path without symlinks.");
  }

  if (worktree === (await realpath(homedir()))) {
    throw new Error("Sandbox worktree cannot be the personal home directory.");
  }

  const root = join(worktree, ".loopy", "cloud", "sandbox");

  if (resolve(config.stateRoot) !== root) {
    throw new Error("Sandbox state root must be <worktree>/.loopy/cloud/sandbox.");
  }

  const layout = stateLayout(root);

  // Parents come first, so every component is checked before anything is created beneath it.
  for (const directory of [
    join(worktree, ".loopy"),
    join(worktree, ".loopy", "cloud"),
    root,
    layout.receipts,
    layout.staging,
    layout.exports,
    layout.results,
  ]) {
    await mkdir(directory, { mode: 0o700 }).catch((cause: unknown) => {
      if (errnoCode(cause) !== "EEXIST") {
        throw cause;
      }
    });

    if (!(await lstat(directory)).isDirectory()) {
      throw new Error("Sandbox state directories must be real directories without symlinks.");
    }
  }

  return root;
}

const lockSchema = struct({ pid: Schema.Int.check(Schema.isGreaterThan(0)), nonce: Schema.String });

async function readLock(path: string) {
  const bytes = await readBytes(path, 1024);

  return bytes === null ? null : decodeBoundary(lockSchema)(JSON.parse(bytes.toString("utf8")));
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (cause) {
    if (errnoCode(cause) === "ESRCH") {
      return false;
    }

    throw cause;
  }
}

export async function lockStateRoot(root: string): Promise<() => Promise<void>> {
  const layout = stateLayout(root);
  const value = { pid: process.pid, nonce: randomUUID() };

  // A separate exclusive guard prevents concurrent restarts from both reclaiming a dead PID.
  const guard = await open(layout.startGuard, "wx", 0o600).catch((cause: unknown) => {
    if (errnoCode(cause) === "EEXIST") {
      throw new Error(
        "Sandbox startup guard is held. Verify no startup process is running before removing service-start.lock.",
      );
    }

    throw cause;
  });

  try {
    const owner = await readLock(layout.lock);

    if (owner !== null) {
      if (processAlive(owner.pid)) {
        throw new Error("Another sandbox service owns this state root.");
      }

      await unlink(layout.lock);
    }

    const file = await open(layout.lock, "wx", 0o600);

    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }

    await syncDirectory(root);
  } finally {
    await guard.close();
    await unlink(layout.startGuard);
  }

  return async () => {
    const current = await readLock(layout.lock);

    if (current?.nonce !== value.nonce) {
      throw new Error(
        "Sandbox process lock changed owner. Leave it intact and inspect the state root.",
      );
    }

    await unlink(layout.lock);
    await syncDirectory(root);
  };
}
