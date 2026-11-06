import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { struct } from "@loopy/contract/codec";
import { Effect, Schema } from "effect";

const absolute = Schema.String.check(Schema.makeFilter(isAbsolute));

const defaulted = <S extends Schema.Constraint>(schema: S, value: S["Type"]) =>
  Schema.withDecodingDefault(Effect.succeed(value))(schema);

export const sandboxConfigSchema = struct({
  worktree: absolute,
  stateRoot: absolute,
  hostname: defaulted(Schema.Literals(["127.0.0.1", "::1"]), "127.0.0.1"),
  port: defaulted(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })), 4010),
  token: Schema.String.check(Schema.isMinLength(32)),
  dockerContext: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]+$/)),
  image: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/)),
  maxTimeoutMs: defaulted(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600_000 })),
    600_000,
  ),
  memory: defaulted(Schema.String.check(Schema.isPattern(/^[1-9]\d*[mg]$/)), "256m"),
  cpus: defaulted(Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(8)), 1),
  pids: defaulted(Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 1024 })), 64),
});

export type SandboxConfig = Schema.Schema.Type<typeof sandboxConfigSchema>;

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

  for (const part of [".loopy", "cloud", "sandbox", "receipts", "staging", "exports", "results"]) {
    // Each component is checked before descending, including pre-existing directories.
    directory = ["staging", "exports", "results"].includes(part)
      ? join(expected, part)
      : join(directory, part);
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
