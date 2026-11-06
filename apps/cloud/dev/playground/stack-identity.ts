import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const pidSchema = z.number().int().positive();

const supervisorIdentitySchema = z.strictObject({
  root: z.string().refine(isAbsolute),
  state: z.string().refine(isAbsolute),
  profile: z.enum(["default", "architecture"]),
  nonce: z.uuid(),
});

export type StackSelection = Omit<z.infer<typeof supervisorIdentitySchema>, "nonce">;

export type SupervisorIdentity = z.infer<typeof supervisorIdentitySchema>;

export const supervisorManifestSchema = z.object({
  version: z.literal(2),
  owner: pidSchema,
  pgid: pidSchema,
  identity: supervisorIdentitySchema,
  argv: z.array(z.string()),
});

export interface SupervisorProcesses {
  observe(pid: number): Promise<{ pid: number; pgid: number; command: string } | null>;
  signalGroup(pgid: number): void;
}

export const supervisorProcesses: SupervisorProcesses = {
  async observe(pid) {
    const child = Bun.spawn(["ps", "-p", String(pid), "-o", "pid=,pgid=,command="], {
      stdout: "pipe",
      stderr: "ignore",
    });

    const output = await new Response(child.stdout).text();

    if ((await child.exited) !== 0) {
      return null;
    }

    const match = /^\s*(\d+)\s+(\d+)\s+([^\r\n]+)\s*$/.exec(output);

    if (!match) {
      return null;
    }

    return {
      pid: pidSchema.parse(Number(match[1])),
      pgid: pidSchema.parse(Number(match[2])),
      command: z.string().min(1).parse(match[3]).trim(),
    };
  },
  signalGroup(pgid) {
    process.kill(-pgid, "SIGTERM");
  },
};

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
  const parsed = z
    .strictObject({
      profile: z.literal(selection.profile),
      state: z.literal(selection.state),
      nonce: z.uuid(),
    })
    .parse(input);

  return { ...selection, nonce: parsed.nonce };
}

export function requireOwnedSupervisor(
  manifest: z.infer<typeof supervisorManifestSchema>,
  observation: Awaited<ReturnType<SupervisorProcesses["observe"]>>,
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
    JSON.stringify(manifest.argv) !== JSON.stringify(expectedArgv)
  ) {
    throw new Error(
      "Supervisor PID, process group or launch identity does not match. Refusing to signal.",
    );
  }
}
