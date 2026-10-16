import { LocalExecutor, loadLoopy, Registry } from "../../local/index.js";
import { createLoopyRun } from "../../sdk/host.js";
import { type CliContext, requireTarget } from "../context.js";
import { inlineRun } from "../inline-run.js";
import { sdkInput } from "../input.js";
import { printJson } from "../output.js";
import { withRunStore } from "../store.js";

export async function runRun(context: CliContext): Promise<void> {
  const slug = requireTarget(context, "Slug");
  const registry = new Registry(context.home, context.cwd);

  const saved = registry.get(slug);
  const loopy = await loadLoopy(registry.bundlePath(saved.bundleHash));
  const input = await sdkInput(loopy, context);

  await withRunStore(context, async (store) => {
    const runId = crypto.randomUUID();
    const options = { ...context, store, loopy, runId, workspace: context.cwd };
    const create = () => createLoopyRun({ ...options, input, bundleHash: saved.bundleHash });

    if (context.values.detach) {
      await create();
      printJson(await store.getRun(runId));

      return;
    }

    const executor = new LocalExecutor({ home: context.home, secrets: loopy.secrets });
    await create();
    await inlineRun({ ...options, executor });
  });
}
