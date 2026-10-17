import { daemonUrl, readDaemonFile } from "../../local/index.js";
import { type CliContext, expectNoArguments } from "../context.js";
import { printLine } from "../output.js";
import { runForeground } from "./daemon.js";

export async function runUi(context: CliContext): Promise<void> {
  expectNoArguments(context);
  const daemon = readDaemonFile(context.home);

  if (daemon) {
    printLine(daemonUrl(daemon));

    return;
  }

  await runForeground(context, printLine);
}
