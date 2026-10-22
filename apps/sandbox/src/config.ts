import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

export const sandboxConfigSchema = z.strictObject({
  worktree: z.string().refine(isAbsolute, "Supply an absolute worktree path."),
  stateRoot: z.string().refine(isAbsolute, "Supply an absolute sandbox state root."),
  hostname: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(4010),
  token: z.string().min(32),
  dockerContext: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  image: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/),
  maxTimeoutMs: z.number().int().min(1).max(3_600_000).default(600_000),
  memory: z
    .string()
    .regex(/^[1-9]\d*[mg]$/)
    .default("256m"),
  cpus: z.number().positive().max(8).default(1),
  pids: z.number().int().min(16).max(1024).default(64),
});

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

export async function validateStateRoot(config: Pick<SandboxConfig, "worktree" | "stateRoot">) {
  const worktree = resolve(config.worktree);

  if ((await realpath(worktree)) !== worktree) {
    throw new Error("Worktree must use its real path without symlinks.");
  }

  if (worktree === (await realpath(homedir()))) {
    throw new Error("Sandbox worktree cannot be the personal home directory.");
  }

  const expected = join(worktree, ".loopy", "cloud", "sandbox");

  if (resolve(config.stateRoot) !== expected) {
    throw new Error("Sandbox state root must be <worktree>/.loopy/cloud/sandbox.");
  }

  let directory = worktree;

  for (const part of [".loopy", "cloud", "sandbox", "receipts", "staging"]) {
    // Each component is checked before descending, including pre-existing directories.
    directory = part === "staging" ? join(expected, part) : join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch((cause: unknown) => {
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) {
        throw cause;
      }
    });

    if (!(await lstat(directory)).isDirectory()) {
      throw new Error("Sandbox state directories must be real directories without symlinks.");
    }
  }

  return expected;
}
