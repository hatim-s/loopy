import { Effect } from "effect";
import { daemonUrl, readDaemonFile } from "../../local/index.js";
import { type CliContext, expectNoArguments } from "../context.js";
import { cliSync } from "../errors.js";
import { printLine } from "../output.js";
import { runForeground } from "./daemon.js";

export function runUi(context: CliContext) {
  return Effect.gen(function* () {
    yield* expectNoArguments(context);
    const daemon = yield* cliSync(() => readDaemonFile(context.home));

    if (daemon) {
      printLine(daemonUrl(daemon));

      return;
    }

    yield* runForeground(context, printLine);
  });
}
