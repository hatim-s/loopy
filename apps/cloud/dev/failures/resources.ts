import { errnoCode } from "@loopy/core";
import { assert } from "../shared/assert";
import { docker as runDocker } from "../shared/process";
import { root } from "../stack/constants";
import { OwnedResources } from "../stack/owned";
import { processFields, processTree } from "../stack/processes";
import { environment, sandboxState } from "./config";

export const docker = (args: string[]) => runDocker(args, { env: environment });

export const owned = new OwnedResources(sandboxState, docker);

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
