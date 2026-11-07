#!/usr/bin/env bun
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { errorMessage } from "@loopy/core";
import { defaultHome } from "@loopy/runtime/local";
import { Cause, Effect, Exit } from "effect";
import { parseCliArgs } from "./args";
import { runCancel } from "./commands/cancel";
import { runDaemon } from "./commands/daemon";
import { runGraph } from "./commands/graph";
import { runHook } from "./commands/hook";
import { runInspect } from "./commands/inspect";
import { runList } from "./commands/list";
import { runLogs } from "./commands/logs";
import { runResume } from "./commands/resume";
import { runRun } from "./commands/run";
import { runRuns } from "./commands/runs";
import { runSave } from "./commands/save";
import { runSchedule } from "./commands/schedule";
import { runSecrets } from "./commands/secrets";
import { runTypes } from "./commands/types";
import { runUi } from "./commands/ui";
import { CliError, cliIO, cliSync } from "./errors";
import { printLine, report } from "./output";
import { usage } from "./usage";

const COMMANDS = {
  graph: runGraph,
  cancel: runCancel,
  daemon: runDaemon,
  inspect: runInspect,
  hook: runHook,
  list: runList,
  logs: runLogs,
  resume: runResume,
  run: runRun,
  runs: runRuns,
  save: runSave,
  schedule: runSchedule,
  secrets: runSecrets,
  types: runTypes,
  ui: runUi,
};

function isCommandName(value: string): value is keyof typeof COMMANDS {
  return Object.hasOwn(COMMANDS, value);
}

const leaseMilliseconds = Effect.fn(function* (value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  const lease = Number(value);

  if (!Number.isSafeInteger(lease) || lease < 1000) {
    return yield* new CliError({
      message: "--lease-ms must be an integer of at least 1000. Use 1000 or more.",
    });
  }

  return lease;
});

export const main = (args = process.argv.slice(2)) =>
  Effect.gen(function* () {
    const { values, positionals, namedInput } = yield* cliSync(() => parseCliArgs(args));
    const [command, ...rest] = positionals;

    if (values.help || !command) {
      printLine(usage());

      return;
    }

    const handler = isCommandName(command) ? COMMANDS[command] : undefined;

    if (!handler) {
      return yield* new CliError({ message: `Unknown command '${command}'. Run loopy --help.` });
    }

    yield* handler({
      home: resolve(values.home ?? defaultHome()),
      leaseMs: yield* leaseMilliseconds(values["lease-ms"]),
      cwd: yield* cliIO(() => realpath(resolve(values.cwd ?? process.cwd()))),
      values,
      positionals: rest,
      namedInput,
    });
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
