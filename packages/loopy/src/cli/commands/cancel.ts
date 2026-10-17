import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";
import { runService, withRunStore } from "../store.js";

export async function runCancel(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  await withRunStore(context, async (store) => {
    printJson(await runService(context, store).cancelRun(id));
  });
}
