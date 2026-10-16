import { LocalExecutor, loadRunLoopy } from "../../local/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { withEngineStore } from "../engine-store.js";
import { inlineRun } from "../inline-run.js";
import { runLegacyResume } from "./legacy-resume.js";

export async function runResume(context: CliContext): Promise<void> {
  const runId = requireTarget(context, "Run ID");
  await withEngineStore(context.home, async (store) => {
    const run = await store.getRun(runId);

    if (!run) {
      return runLegacyResume(context);
    }

    const loopy = await loadRunLoopy(context.home, run);

    if (context.values.full || context.values["retry-uncertain"]) {
      throw new Error(
        "SDK loopies declare mode in loopy({ mode }). Remove --full and --retry-uncertain.",
      );
    }

    const executor = new LocalExecutor({ home: context.home, secrets: loopy.secrets });
    await inlineRun({ ...context, store, loopy, runId, executor });
  });
}
