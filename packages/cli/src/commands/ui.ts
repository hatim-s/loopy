import { DEFAULT_PORT, daemonUrl, readDaemonFile } from "@loopy/runtime/local";
import { Effect } from "effect";
import { defineCommand } from "../command";
import { CliError, cliSync } from "../errors";
import { printLine } from "../output";
import { DAEMON_OPTIONS, runForeground } from "./daemon";

export const ui = defineCommand({
  path: ["ui"],
  summary: "Print the dashboard URL, starting the daemon if needed",
  options: {
    port: {
      type: "integer",
      value: "port",
      min: 0,
      max: 65535,
      description: `Port when ui starts the daemon; a running daemon must match. Default: ${DEFAULT_PORT}.`,
    },
    "lease-ms": DAEMON_OPTIONS["lease-ms"],
  },
  positionals: [],
  run: (cli) =>
    Effect.gen(function* () {
      const { port } = cli.values;
      const daemon = yield* cliSync(() => readDaemonFile(cli.home));

      if (daemon && port !== undefined && port !== 0 && port !== daemon.port) {
        return yield* new CliError({
          message: `A daemon is already running on port ${daemon.port}. Omit --port or stop that daemon first.`,
        });
      }

      if (daemon) {
        printLine(daemonUrl(daemon));

        return;
      }

      yield* runForeground(
        {
          home: cli.home,
          cwd: cli.cwd,
          port: port ?? DEFAULT_PORT,
          concurrency: DAEMON_OPTIONS.concurrency.default,
          leaseMs: cli.values["lease-ms"],
        },
        printLine,
      );
    }),
});
