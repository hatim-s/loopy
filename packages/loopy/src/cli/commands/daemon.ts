import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Cause, Deferred, Effect } from "effect";
import {
  DEFAULT_PORT,
  installDaemon,
  localDaemon,
  readDaemonFile,
  uninstallDaemon,
} from "../../local/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { CliError, cliIO, cliSync } from "../errors.js";
import { printJson, printLine, report } from "../output.js";
import { onTermination } from "../signals.js";
import { withRunStore } from "../store.js";

export const runDaemon = Effect.fn(function* (context: CliContext) {
  const action = yield* requireTarget(context, "Daemon action");

  if (action === "install") {
    yield* installService(context);
    report("Installed the daemon service. Use loopy daemon status to inspect it.");
  } else if (action === "uninstall") {
    yield* uninstallDaemon();
    report("Uninstalled the daemon service.");
  } else if (action === "status") {
    printJson((yield* cliSync(() => readDaemonFile(context.home))) ?? { state: "stopped" });
  } else if (action === "run") {
    yield* runForeground(context, reportAddress);
  } else {
    return yield* Effect.fail(
      new CliError({
        message: "Unknown daemon action. Use loopy daemon run, install, uninstall or status.",
      }),
    );
  }
});

const installService = Effect.fn(function* (context: CliContext) {
  const { port, concurrency } = yield* daemonFlags(context);
  const entry = process.argv[1];

  if (!entry) {
    return yield* Effect.fail(
      new CliError({
        message: "Cannot resolve the CLI entry. Run loopy daemon install from the installed CLI.",
      }),
    );
  }

  yield* installDaemon({
    home: context.home,
    executable: yield* cliIO(() => realpath(process.execPath)),
    args: [
      yield* cliIO(() => realpath(resolve(entry))),
      "--concurrency",
      String(concurrency),
      "--port",
      String(port),
    ],
  });
});

function reportAddress(url: string) {
  printLine(new URL(url).origin);
  printLine("Run loopy ui to open the dashboard.");
}

export const runForeground = Effect.fn(function* (
  context: CliContext,
  onStarted: (url: string) => void,
) {
  const flags = yield* daemonFlags(context);
  yield* withRunStore(context, (store) =>
    Effect.scoped(
      Effect.gen(function* () {
        const terminated = yield* Deferred.make<void>();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            onTermination(() => {
              Deferred.doneUnsafe(terminated, Effect.void);
            }),
          ),
          (cleanup) => Effect.sync(cleanup),
        );

        const daemon = yield* localDaemon({
          ...context,
          store,
          ...flags,
          onError: (cause, run) => report(`${run ? `Run ${run.id}: ` : ""}${Cause.pretty(cause)}`),
        });

        onStarted(yield* daemon.start);
        yield* Effect.raceFirst(daemon.run, Deferred.await(terminated));
      }),
    ),
  );
});

const daemonFlags = Effect.fn(function* (context: CliContext) {
  const port = context.values.port === undefined ? DEFAULT_PORT : Number(context.values.port);

  const concurrency =
    context.values.concurrency === undefined ? 4 : Number(context.values.concurrency);

  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    return yield* Effect.fail(
      new CliError({
        message: "Daemon concurrency must be a positive integer. Supply at least one worker.",
      }),
    );
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return yield* Effect.fail(
      new CliError({ message: "Port must be an integer from 0 to 65535." }),
    );
  }

  return { port, concurrency };
});
