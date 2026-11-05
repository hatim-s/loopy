import { Effect } from "effect";
import { routes } from "../../contract/index.js";
import { isTerminalRun } from "../../core/index.js";
import { request } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson, printLine } from "../output.js";

const LOG_PAGE_SIZE = 200;

function drainLogs(context: CliContext, id: string, cursor: number) {
  return Effect.gen(function* () {
    let after = cursor;

    while (true) {
      const logs = yield* request(
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

      if (logs.length < LOG_PAGE_SIZE) {
        return after;
      }
    }
  });
}

export function runLogs(context: CliContext) {
  return Effect.gen(function* () {
    const id = yield* requireTarget(context, "Run ID");
    let after = 0;

    while (true) {
      const snapshot = yield* request(
        context,
        `/runs/${encodeURIComponent(id)}`,
        routes.run.response,
      );

      after = yield* drainLogs(context, id, after);

      if (!context.values.follow || isTerminalRun(snapshot.run.status)) {
        return;
      }

      yield* Effect.sleep(500);
    }
  });
}
