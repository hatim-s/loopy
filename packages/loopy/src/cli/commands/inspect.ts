import { type CliContext, requireTarget } from "../context.js";
import { withEngineStore } from "../engine-store.js";
import { printJson } from "../output.js";
import { runInspect as legacyInspect } from "./legacy-inspect.js";

export async function runInspect(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  await withEngineStore(context.home, async (store) => {
    const run = await store.getRun(id);

    if (!run) {
      return legacyInspect(context);
    }

    printJson({ run, steps: await store.getSteps(id) });
  });
}
