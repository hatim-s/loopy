import { type CliContext, requireTarget } from "../context.js";
import { withLocalRuntime } from "../local-runtime.js";
import { printJson } from "../output.js";

export async function runInspect(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  const detail = await withLocalRuntime(context.home, async ({ runtime }) => {
    const run = await runtime.getRun(id);
    if (!run) {
      throw new Error(`Unknown run '${id}'.`);
    }
    return {
      run,
      attempts: await runtime.getAttempts(run.id),
      events: await runtime.getEvents(run.id),
    };
  });
  printJson(detail);
}
