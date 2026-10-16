import { loadRunLoopy } from "../../local/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { withEngineStore } from "../engine-store.js";
import { inlineRun } from "../inline-run.js";
import { runResume as legacyResume } from "./legacy-resume.js";

export async function runResume(context: CliContext): Promise<void> {
  const runId = requireTarget(context, "Run ID");
  await withEngineStore(context.home, async (store) => {
    const run = await store.getRun(runId);

    if (!run) {
      return legacyResume(context);
    }

    const loopy = await loadRunLoopy(context.home, context.cwd, run);
    await inlineRun({ ...context, store, loopy, runId });
  });
}
