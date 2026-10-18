#!/usr/bin/env bun
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { errorMessage } from "../core/index.js";
import { defaultHome } from "../local/index.js";
import { parseCliArgs } from "./args.js";
import { runCancel } from "./commands/cancel.js";
import { runDaemon } from "./commands/daemon.js";
import { runGraph } from "./commands/graph.js";
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
import type { CliContext } from "./context.js";
import { DaemonError } from "./errors.js";
import { printLine, report } from "./output.js";
import { usage } from "./usage.js";

const COMMANDS = {
  graph: runGraph,
  cancel: runCancel,
  daemon: runDaemon,
  inspect: runInspect,
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
} satisfies Record<string, (context: CliContext) => Promise<void>>;

function isCommandName(value: string): value is keyof typeof COMMANDS {
  return Object.hasOwn(COMMANDS, value);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals, namedInput } = parseCliArgs(args);
  const [command, ...rest] = positionals;

  if (values.help || !command) {
    printLine(usage());

    return;
  }

  const handler = isCommandName(command) ? COMMANDS[command] : undefined;

  if (!handler) {
    throw new DaemonError("bad_request", `Unknown command '${command}'. Run loopy --help.`);
  }

  await handler({
    home: resolve(values.home ?? defaultHome()),
    cwd: await realpath(resolve(values.cwd ?? process.cwd())),
    values,
    positionals: rest,
    namedInput,
  });
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    const error =
      cause instanceof DaemonError ? cause : new DaemonError("internal", errorMessage(cause));

    report(`[${error.code}] ${error.message}`);
    process.exitCode = 1;
  });
}
