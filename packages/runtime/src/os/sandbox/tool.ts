import { Effect } from "effect";
import { unstarted } from "../spawn";
import { executable } from "./paths";

export type SandboxTool = { kind: "darwin"; exec: string } | { kind: "linux"; bwrap: string };

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"];

/** Commands, bundles and the compiler all run under the same platform sandbox tool. */
export const sandboxTool = Effect.fn(function* () {
  if (process.platform === "darwin" && (yield* executable(SANDBOX_EXEC))) {
    return { kind: "darwin", exec: SANDBOX_EXEC } satisfies SandboxTool;
  }

  if (process.platform === "linux") {
    for (const bwrap of BWRAP_CANDIDATES) {
      if (yield* executable(bwrap)) {
        return { kind: "linux", bwrap } satisfies SandboxTool;
      }
    }
  }

  return yield* Effect.fail(
    unstarted(
      new Error(
        "Sandboxing requires /usr/bin/sandbox-exec on macOS or bubblewrap on Linux. Install the tool for this platform.",
      ),
    ),
  );
});

const CONTROL_CHARACTERS = /[\0\n\r]/;

export function sbpl(path: string): string {
  if (CONTROL_CHARACTERS.test(path)) {
    throw new Error("Paths with control characters cannot be sandboxed. Rename the path.");
  }

  return JSON.stringify(path);
}
