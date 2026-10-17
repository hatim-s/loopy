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

  await runForeground(context, reportAddress);
}

async function installService(context: CliContext): Promise<void> {
  const { port, concurrency } = daemonFlags(context);
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
      "--concurrency",
      String(concurrency),
      "--port",
      String(port),
    ],
  });
}

function reportAddress(url: string): void {
  printLine(new URL(url).origin);
  printLine("Run loopy ui to open the dashboard.");
}

export async function runForeground(
  context: CliContext,
  onStarted: (url: string) => void,
): Promise<void> {
  const flags = daemonFlags(context);
  await withRunStore(context, async (store) => {
    const daemon = localDaemon({
      ...context,
      store,
      ...flags,
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

function daemonFlags(context: CliContext) {
  const port = context.values.port === undefined ? DEFAULT_PORT : Number(context.values.port);

  const concurrency =
    context.values.concurrency === undefined ? 4 : Number(context.values.concurrency);

  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Daemon concurrency must be a positive integer. Supply at least one worker.");
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Port must be an integer from 0 to 65535.");
  }

  return { port, concurrency };
}
