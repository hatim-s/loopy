#!/usr/bin/env bun
import { errorMessage } from "@loopy/core";
import { Cause, Effect, Exit } from "effect";
import { resolveContext } from "./context";
import { printLine, report } from "./output";
import { parseCommandLine } from "./parse";
import { COMMANDS } from "./table";
import { commandUsage, usage } from "./usage";

export const main = (args = process.argv.slice(2)) =>
  Effect.gen(function* () {
    const parsed = yield* parseCommandLine(COMMANDS, args);

    if (parsed.kind === "usage") {
      printLine(parsed.command ? commandUsage(parsed.command) : usage(COMMANDS));

      return;
    }

    yield* parsed.command.run(yield* resolveContext(parsed.globals), parsed.arguments);
  });

export async function runCli() {
  const exit = await Effect.runPromiseExit(main());

  if (Exit.isFailure(exit)) {
    const messages = exit.cause.reasons.map((reason) =>
      Cause.isFailReason(reason)
        ? errorMessage(reason.error)
        : Cause.isDieReason(reason)
          ? errorMessage(reason.defect)
          : "Interrupted.",
    );

    report(messages.join("\n"));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await runCli();
}
