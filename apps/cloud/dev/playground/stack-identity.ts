import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodeBoundary } from "@loopy/contract";
import { Schema } from "effect";

const pidSchema = Schema.Int.check(Schema.isGreaterThan(0));

const absolutePath = Schema.String.check(
  Schema.makeFilter(isAbsolute, { message: "Supply an absolute path." }),
);

const supervisorIdentitySchema = Schema.Struct({
  root: absolutePath,
  state: absolutePath,
  profile: Schema.Literals(["default", "architecture"]),
  nonce: Schema.String.check(Schema.isUUID()),
});

export type SupervisorIdentity = typeof supervisorIdentitySchema.Type;

export type StackSelection = Omit<SupervisorIdentity, "nonce">;

export const supervisorManifestSchema = Schema.Struct({
  version: Schema.Literal(2),
  owner: pidSchema,
  pgid: pidSchema,
  identity: supervisorIdentitySchema,
  argv: Schema.Array(Schema.String),
  root: Schema.String,
  api: Schema.String,
  dashboard: Schema.String,
  state: Schema.String,
  sandboxState: Schema.String,
  dockerContext: Schema.String,
  createdAt: Schema.String,
  stopCommand: Schema.String,
  children: Schema.Array(Schema.Struct({ name: Schema.String, pid: pidSchema })),
});

export type SupervisorManifest = typeof supervisorManifestSchema.Type;

export type ProcessObservation = { pid: number; pgid: number; command: string } | null;

export async function observeProcess(pid: number): Promise<ProcessObservation> {
  const child = Bun.spawn(["ps", "-p", String(pid), "-o", "pid=,pgid=,command="], {
    stdout: "pipe",
    stderr: "ignore",
  });

  const output = await new Response(child.stdout).text();

  if ((await child.exited) !== 0) {
    return null;
  }

  const [, observed, group, command] = /^\s*(\d+)\s+(\d+)\s+([^\r\n]+)\s*$/.exec(output) ?? [];

  if (observed === undefined || group === undefined || command === undefined) {
    return null;
  }

  return {
    pid: decodeBoundary(pidSchema)(Number(observed)),
    pgid: decodeBoundary(pidSchema)(Number(group)),
    command: command.trim(),
  };
}

export function supervisorArguments(identity: SupervisorIdentity) {
  return [
    "--no-env-file",
    resolve(identity.root, "apps/cloud/dev/playground/index.ts"),
    "serve",
    "--profile",
    identity.profile,
    "--state-root",
    identity.state,
    "--launch-nonce",
    identity.nonce,
  ];
}

export function parseServeIdentity(
  input: { profile: string | undefined; state: string | undefined; nonce: string | undefined },
  selection: StackSelection,
) {
  const parsed = decodeBoundary(
    Schema.Struct({
      profile: Schema.Literal(selection.profile),
      state: Schema.Literal(selection.state),
      nonce: Schema.String.check(Schema.isUUID()),
    }),
  )(input);

  return { ...selection, nonce: parsed.nonce };
}

export function requireOwnedSupervisor(
  manifest: Pick<SupervisorManifest, "owner" | "pgid" | "identity" | "argv">,
  observation: ProcessObservation,
  selection: StackSelection,
) {
  const expectedArgv = [process.execPath, ...supervisorArguments(manifest.identity)];

  if (
    manifest.identity.root !== selection.root ||
    manifest.identity.state !== selection.state ||
    manifest.identity.profile !== selection.profile ||
    manifest.pgid !== manifest.owner ||
    observation?.pid !== manifest.owner ||
    observation.pgid !== manifest.pgid ||
    observation.command !== expectedArgv.join(" ") ||
    !isDeepStrictEqual(manifest.argv, expectedArgv)
  ) {
    throw new Error(
      "Supervisor PID, process group or launch identity does not match. Refusing to signal.",
    );
  }
}
