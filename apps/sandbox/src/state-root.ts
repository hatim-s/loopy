import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { errnoCode } from "@loopy/core";
import { readRegularFile } from "@loopy/runtime/os";
import type { SandboxConfig } from "./config";

// Journal records stay small; legacy receipts that embed a captured result fit as well.
export const STATE_FILE_BYTES = 2 * 1024 * 1024;

export function sandboxStateRoot(worktree: string) {
  return join(resolve(worktree), ".loopy", "cloud", "sandbox");
}

export function stateLayout(root: string) {
  return {
    receipts: join(root, "receipts"),
    staging: join(root, "staging"),
    exports: join(root, "exports"),
    results: join(root, "results"),
    lock: join(root, "service.lock"),
  };
}

// Sandboxes before the shared pid lock wrote this file as JSON `{pid, nonce}`. The shared lock
// cannot read that owner, so startup names the manual cleanup instead of converting it.
function rejectPreviousLock(path: string) {
  if (readRegularFile(path, 1024)?.toString("utf8").trimStart().startsWith("{")) {
    throw new Error(
      `Lock file '${path}' was written by an older sandbox version. Stop any sandbox running on this state root, delete the file, and start again.`,
    );
  }
}

export async function validateStateRoot(config: Pick<SandboxConfig, "worktree">) {
  const worktree = resolve(config.worktree);

  if ((await realpath(worktree)) !== worktree) {
    throw new Error("Worktree must use its real path without symlinks.");
  }

  if (worktree === (await realpath(homedir()))) {
    throw new Error("Sandbox worktree cannot be the personal home directory.");
  }

  const root = sandboxStateRoot(worktree);
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

  rejectPreviousLock(layout.lock);

  return root;
}
