import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { errnoCode } from "@loopy/core";
import { Effect, Schema } from "effect";
import { filesystemReceipt } from "../filesystem-receipt";
import { assert } from "../shared/assert";
import { command, docker as runDocker } from "../shared/process";
import { root } from "../stack/constants";
import { environment, owner, sandboxState } from "./config";

export const docker = (args: string[]) => runDocker(args, { env: environment });

const containerSchema = Schema.Tuple([
  Schema.Struct({
    Name: Schema.String,
    Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
    State: Schema.Struct({ Running: Schema.Boolean }),
    Mounts: Schema.Array(
      Schema.Struct({ Type: Schema.String, Name: Schema.optional(Schema.String) }),
    ),
  }),
]);

const decodeContainer = Schema.decodeUnknownSync(containerSchema);

export async function ownedContainer(name: string) {
  const [row] = decodeContainer(JSON.parse(await docker(["inspect", name])));
  assert(row.Config.Labels["loopy.sandbox.owner"] === owner, "container_owner_mismatch");

  return row;
}

export async function receipts() {
  const files = await readdir(resolve(sandboxState, "receipts"));

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

async function processTable() {
  const rows = (await command(["/bin/ps", "-axo", "pid=,ppid="], { env: environment }))
    .trim()
    .split("\n");

  return rows.flatMap((row) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);

    return match ? [{ pid: Number(match[1]), parent: Number(match[2]) }] : [];
  });
}

// Each pid is re-read before signalling so a recycled pid never receives the signal.
export async function stop(child: ReturnType<typeof Bun.spawn>, signal: "SIGTERM" | "SIGKILL") {
  if (child.exitCode !== null) {
    return;
  }

  const rows = await processTable();
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
        if (errnoCode(cause) !== "ESRCH") {
          throw cause;
        }
      }
    }
  }

  await child.exited;
}
