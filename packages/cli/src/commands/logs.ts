import { routes } from "@loopy/contract";
import { isTerminalRun } from "@loopy/core";
import { Effect } from "effect";
import { request } from "../client";
import { defineCommand, RUN_ID } from "../command";
import type { Context } from "../context";
import { printJson, printLine } from "../output";

const LOG_PAGE_SIZE = 200;

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
      const logs = yield* request(
        context,
        `/runs/${encodeURIComponent(id)}/logs?after=${cursor}`,
        routes.logs.response,
      );

      for (const log of logs) {
        if (follow) {
          printLine(JSON.stringify(log));
        } else {
          printJson(log);
        }

        cursor = log.seq;
      }

      if (logs.length < LOG_PAGE_SIZE) {
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
        const snapshot = yield* request(
          cli,
          `/runs/${encodeURIComponent(id)}`,
          routes.run.response,
        );

        after = yield* drainLogs(cli, id, { after, follow });

        if (!follow || isTerminalRun(snapshot.run.status)) {
          return;
        }

        yield* Effect.sleep(FOLLOW_POLL_MS);
      }
    }),
});
