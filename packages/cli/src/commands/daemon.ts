import { realpath } from "node:fs/promises";
import {
  DEFAULT_PORT,
  installDaemon,
  localDaemon,
  openRunStore,
  readDaemonFile,
  uninstallDaemon,
} from "@loopy/runtime/local";
import { Cause, Deferred, Effect } from "effect";
import { defineCommand, type Options } from "../command";
import type { Context } from "../context";
import { DASHBOARD_ASSETS, daemonCommand } from "../entry";
import { cliIO, cliSync } from "../errors";
import { printJson, printLine, report } from "../output";

export const DAEMON_OPTIONS = {
  concurrency: {
    type: "integer",
    value: "n",
    min: 1,
    default: 4,
    description: "Runs executed at the same time.",
  },
  port: {
    type: "integer",
    value: "port",
    min: 0,
    max: 65535,
    default: DEFAULT_PORT,
    description: "Dashboard and API port; 0 picks a free port.",
  },
  "lease-ms": {
    type: "integer",
    value: "ms",
    min: 1000,
    description: "Run ownership lease in milliseconds (store default 60000).",
  },
} as const satisfies Options;

type ForegroundOptions = Pick<Context, "home" | "cwd"> & {
  port: number;
  concurrency: number;
  leaseMs: number | undefined;
};

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export const runForeground = Effect.fn(function* (
  options: ForegroundOptions,
  onStarted: (url: string) => void,
) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      // Only daemon control opens the database; data commands use HTTP.
      const store = yield* openRunStore(options.home, { leaseMs: options.leaseMs });
      const terminated = yield* Deferred.make<void>();

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const terminate = () => Deferred.doneUnsafe(terminated, Effect.void);

          for (const signal of TERMINATION_SIGNALS) {
            process.once(signal, terminate);
          }

          return terminate;
        }),
        (terminate) =>
          Effect.sync(() => {
            for (const signal of TERMINATION_SIGNALS) {
              process.removeListener(signal, terminate);
            }
          }),
      );

      const daemon = yield* localDaemon({
        home: options.home,
        cwd: options.cwd,
        store,
        port: options.port,
        concurrency: options.concurrency,
        assets: DASHBOARD_ASSETS,
        onError: (cause, run) => report(`${run ? `Run ${run.id}: ` : ""}${Cause.pretty(cause)}`),
      });

      onStarted(yield* daemon.start);
      yield* Effect.raceFirst(daemon.run, Deferred.await(terminated));
    }),
  );
});

export const daemonRun = defineCommand({
  path: ["daemon", "run"],
  summary: "Run the foreground daemon",
  options: DAEMON_OPTIONS,
  positionals: [],
  run: (cli) =>
    runForeground(
      {
        home: cli.home,
        cwd: cli.cwd,
        port: cli.values.port,
        concurrency: cli.values.concurrency,
        leaseMs: cli.values["lease-ms"],
      },
      (url) => {
        printLine(new URL(url).origin);
        printLine("Run loopy ui to open the dashboard.");
      },
    ),
});

export const daemonInstall = defineCommand({
  path: ["daemon", "install"],
  summary: "Install and start the user service",
  options: DAEMON_OPTIONS,
  positionals: [],
  run: (cli) =>
    Effect.gen(function* () {
      const [executable, entry, ...args] = daemonCommand({
        home: cli.home,
        port: cli.values.port,
        concurrency: cli.values.concurrency,
        leaseMs: cli.values["lease-ms"],
      });

      yield* installDaemon({
        home: cli.home,
        command: [
          yield* cliIO(() => realpath(executable)),
          yield* cliIO(() => realpath(entry)),
          ...args,
        ],
      });
      report("Installed the daemon service. Use loopy daemon status to inspect it.");
    }),
});

export const daemonUninstall = defineCommand({
  path: ["daemon", "uninstall"],
  summary: "Remove the user service",
  options: {},
  positionals: [],
  run: () =>
    Effect.gen(function* () {
      yield* uninstallDaemon();
      report("Uninstalled the daemon service.");
    }),
});

export const daemonStatus = defineCommand({
  path: ["daemon", "status"],
  summary: "Show daemon.json PID, port, token and start time",
  options: {},
  positionals: [],
  run: (cli) =>
    Effect.gen(function* () {
      printJson((yield* cliSync(() => readDaemonFile(cli.home))) ?? { state: "stopped" });
    }),
});
