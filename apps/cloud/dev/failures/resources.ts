import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { filesystemReceipt } from "../filesystem-receipt";
import { assert } from "../journey/client";
import { environment, owner, root, sandboxState } from "./config";

export async function command(argv: string[]) {
  const child = Bun.spawn(argv, { cwd: root, env: environment, stdout: "pipe", stderr: "pipe" });

  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  assert(exitCode === 0, "owned_command_failed", { program: argv[0] ?? "", exitCode });

  return stdout;
}

export const docker = (args: string[]) =>
  command(["docker", "--context", "colima-loopy-cloud-phase1", ...args]);

const containerSchema = z.array(
  z.object({
    Name: z.string(),
    Config: z.object({ Labels: z.record(z.string(), z.string()) }),
    State: z.object({ Running: z.boolean() }),
    Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional() })),
  }),
);

export async function ownedContainer(name: string) {
  const row = containerSchema.parse(JSON.parse(await docker(["inspect", name])))[0];
  assert(row?.Config.Labels["loopy.sandbox.owner"] === owner, "container_owner_mismatch");

  return row;
}

export async function receipts() {
  const directory = resolve(sandboxState, "receipts");
  const files = await readdir(directory);

  return Effect.runPromise(
    Effect.all(
      files
        .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
        .map((file) => filesystemReceipt(sandboxState, file.slice(0, -5))),
    ),
  );
}

async function identity(pid: number) {
  const child = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "lstart=,command="], {
    stdout: "pipe",
    stderr: "ignore",
    env: environment,
  });

  const value = await new Response(child.stdout).text();

  return (await child.exited) === 0 ? value.trim() : null;
}

export async function stop(child: ReturnType<typeof Bun.spawn>, signal: "SIGTERM" | "SIGKILL") {
  if (child.exitCode !== null) {
    return;
  }

  const rows = (await command(["/bin/ps", "-axo", "pid=,ppid="]))
    .trim()
    .split("\n")
    .map((row) => {
      const [pid, parent] = row.trim().split(/\s+/).map(Number);

      return { pid: pid ?? 0, parent: parent ?? 0 };
    });

  const descendants = new Set([child.pid]);

  for (let added = true; added; ) {
    added = false;

    for (const row of rows) {
      if (descendants.has(row.parent) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        added = true;
      }
    }
  }

  const pinned = await Promise.all(
    [...descendants].map(async (pid) => ({ pid, value: await identity(pid) })),
  );

  assert(pinned[0]?.value?.includes(root), "process_root_identity_mismatch");

  for (const entry of pinned) {
    if (entry.value !== null && (await identity(entry.pid)) === entry.value) {
      try {
        process.kill(entry.pid, signal);
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) {
          throw cause;
        }
      }
    }
  }

  await child.exited;
}
