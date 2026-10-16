import { LocalExecutor, Loopies, loadLoopy } from "../../local/index.js";
import { startLoopy } from "../../sdk/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { withEngineStore } from "../engine-store.js";
import { inlineRun } from "../inline-run.js";
import { printJson } from "../output.js";
import { sdkInput } from "../sdk-input.js";
import { runRun as legacyRun } from "./legacy-run.js";

export async function runRun(context: CliContext): Promise<void> {
  const slug = requireTarget(context, "Slug");
  const registry = new Loopies(context.home, context.cwd);

  if (!registry.has(slug)) {
    return legacyRun(context);
  }

  const saved = registry.get(slug);
  const loopy = await loadLoopy(registry.bundlePath(saved.bundleHash));
  const input = await sdkInput(loopy, context);
  await withEngineStore(context.home, async (store) => {
    const runId = crypto.randomUUID();
    const options = { ...context, store, loopy, runId };
    await startLoopy({
      ...options,
      input,
      bundleHash: saved.bundleHash,
      executor: new LocalExecutor(),
      detach: true,
    });

    if (context.values.detach) {
      printJson(await store.getRun(runId));

      return;
    }

    await inlineRun(options);
  });
}
