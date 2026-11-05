#!/usr/bin/env bun
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { errorMessage } from "../core/index.js";
import { defaultHome } from "../local/index.js";
import { parseCliArgs } from "./args.js";
import { runCancel } from "./commands/cancel.js";
import { runDaemon } from "./commands/daemon.js";
import { runGraph } from "./commands/graph.js";
import { runHook } from "./commands/hook.js";
import { runInspect } from "./commands/inspect.js";
import { runList } from "./commands/list.js";
import { runLogs } from "./commands/logs.js";
import { runResume } from "./commands/resume.js";
import { runRun } from "./commands/run.js";
import { runRuns } from "./commands/runs.js";
import { runSave } from "./commands/save.js";
import { runSchedule } from "./commands/schedule.js";
import { runSecrets } from "./commands/secrets.js";
import { runTypes } from "./commands/types.js";
import { runUi } from "./commands/ui.js";
import { CliError, cliIO, cliSync } from "./errors.js";
import { printLine, report } from "./output.js";
import { usage } from "./usage.js";

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
    return yield* Effect.fail(
      new CliError({
        message: "--lease-ms must be an integer of at least 1000. Use 1000 or more.",
      }),
    );
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
      return yield* Effect.fail(
        new CliError({ message: `Unknown command '${command}'. Run loopy --help.` }),
      );
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

if (import.meta.main) {
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
