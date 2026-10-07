import type { LocalRuntime } from "./local-runtime.js";
import { printJson, report } from "./output.js";
import { untilSignalled } from "./signals.js";

/** Drives a created or resumed run to its end and maps the outcome to the exit code. */
export async function executeRun(
  runtime: LocalRuntime["runtime"],
  id: string,
  retryUncertain: boolean | undefined,
): Promise<void> {
  report(`Run ${id}`);
  const run = await untilSignalled((signal) => runtime.execute(id, { retryUncertain, signal }));
  printJson(run);
  if (run.status !== "succeeded") {
    process.exitCode = 1;
  }
}
