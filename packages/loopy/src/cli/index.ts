#!/usr/bin/env bun
import { resolve } from "node:path";
import { errorMessage } from "../core/index.js";
import { defaultHome } from "../local/index.js";
import { parseCliArgs } from "./args.js";
import { runCancel } from "./commands/cancel.js";
import { runDaemon } from "./commands/daemon.js";
import { runGraph } from "./commands/graph.js";
import { runInspect } from "./commands/inspect.js";
import { runInspect as legacyInspect } from "./commands/legacy-inspect.js";
import { runList as legacyList } from "./commands/legacy-list.js";
import { runResume as legacyResume } from "./commands/legacy-resume.js";
import { runRun as legacyRun } from "./commands/legacy-run.js";
import { runRuns as legacyRuns } from "./commands/legacy-runs.js";
import { runSave as legacySave } from "./commands/legacy-save.js";
import { runList } from "./commands/list.js";
import { runLogs } from "./commands/logs.js";
import { runRecover } from "./commands/recover.js";
import { runResume } from "./commands/resume.js";
import { runRun } from "./commands/run.js";
import { runRuns } from "./commands/runs.js";
import { runSave } from "./commands/save.js";
import { runSchedule } from "./commands/schedule.js";
import { runSecrets } from "./commands/secrets.js";
import { runTypes } from "./commands/types.js";
import { runUi } from "./commands/ui.js";
import type { CliContext } from "./context.js";
import { printLine, report } from "./output.js";
import { usage } from "./usage.js";

const COMMANDS = {
  cancel: runCancel,
  daemon: runDaemon,
  logs: runLogs,
  schedule: runSchedule,
  "legacy:save": legacySave,
  "legacy:run": legacyRun,
  "legacy:runs": legacyRuns,
  "legacy:inspect": legacyInspect,
  "legacy:resume": legacyResume,
  "legacy:list": legacyList,

  save: runSave,
  list: runList,
  graph: runGraph,
  run: runRun,
  resume: runResume,
  recover: runRecover,
  runs: runRuns,
  inspect: runInspect,
  types: runTypes,
  ui: runUi,
  secrets: runSecrets,
} satisfies Record<string, (context: CliContext) => Promise<void>>;

function isCommandName(value: string): value is keyof typeof COMMANDS {
  return Object.hasOwn(COMMANDS, value);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals, triggerInput } = parseCliArgs(args);
  const [command, ...rest] = positionals;

  if (values.help || !command) {
    printLine(usage());

    return;
  }

  const handler = isCommandName(command) ? COMMANDS[command] : undefined;

  if (!handler) {
    throw new Error(`Unknown command '${command}'. Run loopy --help.`);
  }

  await handler({
    home: resolve(values.home ?? defaultHome()),
    cwd: resolve(values.cwd ?? process.cwd()),
    values,
    positionals: rest,
    triggerInput,
  });
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    report(errorMessage(cause));
    process.exitCode = 1;
  });
}
