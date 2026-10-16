import { engineRunDetail } from "../../runtime/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { requireRun, withEngineStore } from "../engine-store.js";
import { printJson } from "../output.js";

export async function runInspect(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  await withEngineStore(context.home, async (store) => {
    printJson(await engineRunDetail(store, await requireRun(store, id)));
  });
}
