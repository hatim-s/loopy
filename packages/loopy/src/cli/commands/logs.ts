import { setTimeout } from "node:timers/promises";
import { routes } from "../../contract/index.js";
import { isTerminalRun } from "../../core/index.js";
import { request } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson, printLine } from "../output.js";

export async function runLogs(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  let after = 0;

  while (true) {
    const snapshot = await request(context, `/runs/${encodeURIComponent(id)}`, routes.run.response);

    const logs = await request(
      context,
      `/runs/${encodeURIComponent(id)}/logs?after=${after}`,
      routes.logs.response,
    );

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
