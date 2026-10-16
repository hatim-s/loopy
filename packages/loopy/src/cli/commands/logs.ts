import { setTimeout } from "node:timers/promises";
import { type CliContext, requireTarget } from "../context.js";
import { isTerminal, requireRun, withEngineStore } from "../engine-store.js";
import { printJson } from "../output.js";

export async function runLogs(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  await withEngineStore(context.home, async (store) => {
    let after = 0;

    while (true) {
      const run = await requireRun(store, id);
      const logs = await store.getLogs(id, after);

      for (const log of logs) {
        printJson(log);
        after = log.seq;
      }

      if (!context.values.follow || isTerminal(run.status)) {
        return;
      }

      await setTimeout(500);
    }
  });
}
