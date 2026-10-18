import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { installDaemon, localDaemon, readDaemonFile, uninstallDaemon } from "../../local/index.js";
import { openRunStore } from "../../store/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { DaemonError } from "../errors.js";
import { printJson, printLine, report } from "../output.js";
import { onTermination } from "../signals.js";

export async function runDaemon(context: CliContext): Promise<void> {
  const action = requireTarget(context, "Daemon action");

  if (action === "install") {
    await installService(context);
    report("Installed the daemon service. Use loopy daemon status to inspect it.");

    return;
  }

  if (action === "uninstall") {
    await uninstallDaemon({ uid: serviceUid() });
    report("Uninstalled the daemon service.");

    return;
  }

  if (action === "status") {
    printJson(readDaemonFile(context.home) ?? { state: "stopped" });

    return;
  }

  await runForeground(context, reportAddress);
}

async function installService(context: CliContext): Promise<void> {
  const { port, concurrency } = context.values;
  const entry = process.argv[1];

  if (!entry) {
    throw new DaemonError(
      "bad_request",
      "Cannot resolve the CLI entry. Run loopy daemon install from the installed CLI.",
    );
  }

  await installDaemon({
    uid: serviceUid(),
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

async function runForeground(context: CliContext, onStarted: (url: string) => void): Promise<void> {
  const { home, cwd, values } = context;
  const store = openRunStore(home, { leaseMs: values["lease-ms"] });

  const daemon = localDaemon({
    home,
    cwd,
    store,
    port: values.port,
    concurrency: values.concurrency ?? 4,
    onError: (error, run) => report(run ? `Run ${run.id}: ${error.message}` : error.message),
  });

  const cleanup = onTermination(() => {
    void daemon.stop();
  });

  try {
    onStarted(await daemon.start());
    await daemon.run();
  } finally {
    cleanup();
    await daemon.stop();
    store.close();
  }
}

function serviceUid(): number {
  if (!process.getuid) {
    throw new DaemonError("bad_request", "Daemon services require macOS or Linux.");
  }

  return process.getuid();
}
