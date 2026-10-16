import { runDetail } from "../../runtime/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";
import { requireRun, withRunStore } from "../store.js";

export async function runInspect(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  await withRunStore(context, async (store) => {
    const detail = await runDetail(store, await requireRun(store, id));
    printJson({ ...detail, hooks: await store.listHooks(id) });
  });
}
