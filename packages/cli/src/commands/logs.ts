import { isTerminalRun, PAGE_LIMIT, routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { defineCommand, RUN_ID } from "../command";
import type { Context } from "../context";
import { printJson, printLine } from "../output";

// Follow polls until the CLI gains an SSE reader like the dashboard's.
const FOLLOW_POLL_MS = 500;

function drainLogs(
  context: Context,
  id: string,
  { after, follow }: { after: number; follow: boolean },
) {
  return Effect.gen(function* () {
    let cursor = after;

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
      const { follow } = cli.values;
      let after = 0;

      while (true) {
        const snapshot = yield* request(cli, routes.run, { params: { id } });

        after = yield* drainLogs(cli, id, { after, follow });

        if (!follow || isTerminalRun(snapshot.run.status)) {
          return;
        }

        yield* Effect.sleep(FOLLOW_POLL_MS);
      }
    }),
});
