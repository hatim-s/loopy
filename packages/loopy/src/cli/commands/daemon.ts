import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_PORT,
  installDaemon,
  localDaemon,
  readDaemonFile,
  uninstallDaemon,
} from "../../local/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson, printLine, report } from "../output.js";
import { onTermination } from "../signals.js";
import { withRunStore } from "../store.js";

export async function runDaemon(context: CliContext): Promise<void> {
  const action = requireTarget(context, "Daemon action");

  if (action === "install") {
    await installService(context);
    report("Installed the daemon service. Use loopy daemon status to inspect it.");

    return;
  }

  if (action === "uninstall") {
    await uninstallDaemon();
    report("Uninstalled the daemon service.");

    return;
  }

  if (action === "status") {
    printJson(readDaemonFile(context.home) ?? { state: "stopped" });

    return;
  }

  if (action !== "run") {
    throw new Error("Unknown daemon action. Use loopy daemon run, install, uninstall or status.");
  }

  await runForeground(context);
}

async function installService(context: CliContext): Promise<void> {
  const value = context.values.concurrency;

  if (value !== undefined && (!Number.isSafeInteger(Number(value)) || Number(value) < 1)) {
    throw new Error("Daemon concurrency must be a positive integer. Supply at least one worker.");
  }

  const entry = process.argv[1];

  if (!entry) {
    throw new Error(
      "Cannot resolve the CLI entry. Run loopy daemon install from the installed CLI.",
    );
  }

  await installDaemon({
    home: context.home,
    executable: await realpath(process.execPath),
    args: [
      await realpath(resolve(entry)),
      ...(value === undefined ? [] : ["--concurrency", value]),
      ...(context.values.port === undefined
        ? []
        : ["--port", String(parsePort(context.values.port))]),
    ],
  });
}

function reportAddress(url: string): void {
  printLine(new URL(url).origin);
  printLine("Run loopy ui to open the dashboard.");
}

export async function runForeground(context: CliContext, onStarted = reportAddress): Promise<void> {
  await withRunStore(context, async (store) => {
    const daemon = localDaemon({
      ...context,
      store,
      port: parsePort(context.values.port),
      concurrency:
        context.values.concurrency === undefined ? undefined : Number(context.values.concurrency),
      onError: (error, run) => report(run ? `Run ${run.id}: ${error.message}` : error.message),
    });

    const stop = () => {
      void daemon.stop();
    };

    const cleanup = onTermination(stop);

    try {
      onStarted(daemon.start());
      await daemon.run();
    } finally {
      cleanup();
      await daemon.stop();
    }
  });
}

export function parsePort(value: string | undefined): number {
  const port = value === undefined ? DEFAULT_PORT : Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Port must be an integer from 0 to 65535.");
  }

  return port;
}
