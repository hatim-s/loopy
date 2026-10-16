import { existsSync } from "node:fs";
import { join } from "node:path";
import { engineRunDetail } from "../../runtime/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { withEngineStore } from "../engine-store.js";
import { printJson } from "../output.js";
import { runLegacyInspect } from "./legacy-inspect.js";

export async function runInspect(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  await withEngineStore(context.home, async (store) => {
    const run = await store.getRun(id);

    if (!run) {
      return inspectLegacy(context);
    }

    printJson(await engineRunDetail(store, run));
  });
}

async function inspectLegacy(context: CliContext) {
  if (!existsSync(join(context.home, "runs.sqlite"))) {
    throw new Error(
      `No run '${requireTarget(context, "Run ID")}'. Use loopy runs to list run ids.`,
    );
  }

  return runLegacyInspect(context);
}
