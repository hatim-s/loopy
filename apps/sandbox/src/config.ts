import { isAbsolute } from "node:path";
import { struct } from "@loopy/core";
import { Effect, Schema } from "effect";
import { sandboxStateRoot } from "./state-root";

const absolute = Schema.String.check(Schema.makeFilter(isAbsolute));

const defaulted = <S extends Schema.Constraint>(schema: S, value: S["Type"]) =>
  Schema.withDecodingDefault(Effect.succeed(value))(schema);

export const sandboxConfigSchema = struct({
  worktree: absolute,
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

/** The state root is always derived from the worktree, so no caller can point it elsewhere. */
export function sandboxConfig(flags: Schema.Schema.Type<typeof sandboxConfigSchema>) {
  return { ...flags, stateRoot: sandboxStateRoot(flags.worktree) };
}

export type SandboxConfig = ReturnType<typeof sandboxConfig>;
