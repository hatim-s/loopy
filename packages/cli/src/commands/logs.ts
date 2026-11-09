import { isTerminalRun, PAGE_LIMIT, routes } from "@loopy/contract";
import { Effect } from "effect";
import { followEvents, request } from "../client";
import { defineCommand, RUN_ID } from "../command";
import type { Context } from "../context";
import { printJson, printLine } from "../output";

function drainLogs(context: Context, id: string, follow: boolean) {
  return Effect.gen(function* () {
    let cursor = 0;

    while (true) {
      const logs = yield* request(context, routes.logs, {
        params: { id },
        query: { after: cursor, limit: PAGE_LIMIT },
      });

      for (const log of logs) {
        if (follow) {
          printLine(JSON.stringify(log));
        } else {
          printJson(log);
        }

        cursor = log.seq;
      }

      if (logs.length < PAGE_LIMIT) {
        return cursor;
      }
    }
  });
}

export const logs = defineCommand({
  path: ["logs"],
  summary: "Print logs as JSON",
  options: {
    follow: {
      type: "boolean",
      description: "Keep printing until the run finishes, one NDJSON line per log.",
    },
  },
  positionals: [RUN_ID],
  run: (cli) =>
    Effect.gen(function* () {
      const [id] = cli.args;

      if (!cli.values.follow) {
        yield* drainLogs(cli, id, false);

        return;
      }

      // The stream replays from this cursor, so nothing committed during the reads below is lost.
      const from = yield* request(cli, routes.cursor, {});
      const snapshot = yield* request(cli, routes.run, { params: { id } });
      let printed = yield* drainLogs(cli, id, true);

      if (isTerminalRun(snapshot.run.status)) {
        return;
      }

      yield* followEvents(cli, from, (events) => {
        for (const event of events.filter((candidate) => candidate.runId === id)) {
          if (event.entity === "log" && event.record.seq > printed) {
            printLine(JSON.stringify(event.record));
            printed = event.record.seq;
          }

          if (event.entity === "run" && isTerminalRun(event.record.status)) {
            return true;
          }
        }

        return false;
      });
    }),
});
