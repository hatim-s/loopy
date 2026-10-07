import { type CliContext, optionalTarget } from "../context.js";
import { withLocalRuntime } from "../local-runtime.js";
import { printJson } from "../output.js";

export async function runRuns(context: CliContext): Promise<void> {
  const slug = optionalTarget(context);
  printJson(await withLocalRuntime(context.home, ({ runtime }) => runtime.listRuns(slug)));
}
