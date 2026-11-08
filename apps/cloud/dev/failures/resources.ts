import { readdir } from "node:fs/promises";
import { errnoCode } from "@loopy/core";
import { Effect, Schema } from "effect";
import { SANDBOX_LABELS } from "../../../sandbox/src/docker/identity";
import { stateLayout } from "../../../sandbox/src/state-root";
import { filesystemReceipt } from "../filesystem-receipt";
import { assert } from "../shared/assert";
import { docker as runDocker } from "../shared/process";
import { root } from "../stack/constants";
import { processFields, processTree } from "../stack/processes";
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
  assert(row.Config.Labels[SANDBOX_LABELS.owner] === owner, "container_owner_mismatch");

  return row;
}

export async function receipts() {
  const files = await readdir(stateLayout(sandboxState).receipts);

  return Effect.runPromise(
    Effect.all(
      files
        .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
        .map((file) => filesystemReceipt(sandboxState, file.slice(0, -5))),
    ),
  );
}

const identity = (pid: number) => processFields(pid, "lstart=,command=", environment);

// Each pid is re-read before signalling so a recycled pid never receives the signal.
export async function stop(child: ReturnType<typeof Bun.spawn>, signal: "SIGTERM" | "SIGKILL") {
  if (child.exitCode !== null) {
    return;
  }

  const descendants = await processTree([child.pid], environment);

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
