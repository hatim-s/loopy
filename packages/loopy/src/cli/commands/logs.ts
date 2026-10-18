import { setTimeout } from "node:timers/promises";
import { routes } from "../../contract/index.js";
import { isTerminalRun } from "../../core/index.js";
import { call } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson, printLine } from "../output.js";

export async function runLogs(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  let after = 0;

  while (true) {
    const snapshot = await call(context, routes.run, {
      params: { id },
      query: {},
      body: undefined,
    });

    const logs = await call(context, routes.logs, {
      params: { id },
      query: { after },
      body: undefined,
    });

    for (const log of logs) {
      if (context.values.follow) {
        printLine(JSON.stringify(log));
      } else {
        printJson(log);
      }

      after = log.seq;
    }

    if (!context.values.follow || isTerminalRun(snapshot.run.status)) {
      return;
    }

    await setTimeout(500);
  }
}
