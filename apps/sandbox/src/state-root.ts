import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { errnoCode } from "@loopy/core";
import type { SandboxConfig } from "./config";

// Journal records stay small; legacy receipts that embed a captured result fit as well.
export const STATE_FILE_BYTES = 2 * 1024 * 1024;

export function stateLayout(root: string) {
  return {
    receipts: join(root, "receipts"),
    staging: join(root, "staging"),
    exports: join(root, "exports"),
    results: join(root, "results"),
    lock: join(root, "service.lock"),
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
