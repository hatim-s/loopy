import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";
import { withRunStore } from "../store.js";

export async function runInspect(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  await withRunStore(context, async (store) => {
    const snapshot = await store.snapshotRun(id);

    if (!snapshot) {
      throw new Error(`No run '${id}'. Use loopy runs to list run ids.`);
    }

    printJson(snapshot);
  });
}
