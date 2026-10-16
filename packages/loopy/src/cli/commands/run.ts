import { LocalExecutor, Loopies, loadLoopy } from "../../local/index.js";
import { createLoopyRun } from "../../sdk/host.js";
import { type CliContext, requireTarget } from "../context.js";
import { withEngineStore } from "../engine-store.js";
import { inlineRun } from "../inline-run.js";
import { printJson } from "../output.js";
import { sdkInput } from "../sdk-input.js";

export async function runRun(context: CliContext): Promise<void> {
  const slug = requireTarget(context, "Slug");
  const registry = new Loopies(context.home, context.cwd);

  await runSaved(context, registry, slug);
}

async function runSaved(context: CliContext, registry: Loopies, slug: string) {
  const saved = registry.get(slug);
  const loopy = await loadLoopy(registry.bundlePath(saved.bundleHash));
  const input = await sdkInput(loopy, context);

  const executor = context.values.detach
    ? undefined
    : new LocalExecutor({ home: context.home, secrets: loopy.secrets });

  await withEngineStore(context.home, async (store) => {
    const runId = crypto.randomUUID();
    const options = { ...context, store, loopy, runId, workspace: context.cwd };
    await createLoopyRun({
      ...options,
      input,
      bundleHash: saved.bundleHash,
    });

    if (context.values.detach) {
      printJson(await store.getRun(runId));

      return;
    }

    if (executor) {
      await inlineRun({ ...options, executor });
    }
  });
}
