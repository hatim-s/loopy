import { LocalExecutor, loadLoopy, Registry, readRateLimits } from "../../local/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { inlineRun } from "../inline-run.js";
import { sdkInput } from "../input.js";
import { printJson } from "../output.js";
import { runService, withRunStore } from "../store.js";

export async function runRun(context: CliContext): Promise<void> {
  const rateLimits = readRateLimits(context.home);
  const slug = requireTarget(context, "Slug");
  const registry = new Registry(context.home, context.cwd);

  const saved = registry.get(slug);
  const loopy = await loadLoopy(registry.bundlePath(saved.bundleHash));
  const input = await sdkInput(loopy, context);

  await withRunStore(context, async (store) => {
    const executor = context.values.detach
      ? undefined
      : new LocalExecutor({ home: context.home, secrets: loopy.secrets });

    const run = await runService(context, store).startRun(slug, input, context.cwd);
    const runId = run.id;
    const options = { ...context, store, loopy, runId, rateLimits, workspace: context.cwd };

    if (context.values.detach) {
      printJson(run);

      return;
    }

    if (executor) {
      await inlineRun({ ...options, executor });
    }
  });
}
