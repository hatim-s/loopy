import { setTimeout } from "node:timers/promises";
import { isTerminalRun } from "../../core/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson, printLine } from "../output.js";
import { requireRun, withRunStore } from "../store.js";

export async function runLogs(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  await withRunStore(context.home, async (store) => {
    let after = 0;

    while (true) {
      const run = await requireRun(store, id);
      const logs = await store.getLogs(id, after);

      for (const log of logs) {
        if (context.values.follow) {
          printLine(JSON.stringify(log));
        } else {
          printJson(log);
        }

        after = log.seq;
      }

      if (!context.values.follow || isTerminalRun(run.status)) {
        return;
      }

      await setTimeout(500);
    }
  });
}
