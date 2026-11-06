import { daemonUrl, readDaemonFile } from "@loopy/runtime/local";
import { Effect } from "effect";
import { type CliContext, expectNoArguments } from "../context";
import { cliSync } from "../errors";
import { printLine } from "../output";
import { runForeground } from "./daemon";

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
