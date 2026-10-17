import { LocalExecutor, loadRunLoopy, readDaemonFile, readRateLimits } from "../../local/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { inlineRun } from "../inline-run.js";
import { printJson } from "../output.js";
import { requireRun, runService, withRunStore } from "../store.js";

export async function runResume(context: CliContext): Promise<void> {
  const rateLimits = readRateLimits(context.home);
  const runId = requireTarget(context, "Run ID");
  await withRunStore(context, async (store) => {
    const view = await runService(context, store).resumeRun(runId);

    if (readDaemonFile(context.home)) {
      printJson(view);

      return;
    }

    const run = await requireRun(store, runId);

    const loopy = await loadRunLoopy(context.home, run);

    const executor = new LocalExecutor({ home: context.home, secrets: loopy.secrets });
    await inlineRun({ ...context, store, loopy, runId, executor, rateLimits });
  });
}
