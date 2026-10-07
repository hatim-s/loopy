#!/usr/bin/env bun
import { resolve } from "node:path";
import { errorMessage } from "../core/index.js";
import { defaultHome } from "../local/index.js";
import { parseCliArgs } from "./args.js";
import { runGraph } from "./commands/graph.js";
import { runInspect } from "./commands/inspect.js";
import { runList } from "./commands/list.js";
import { runRecover } from "./commands/recover.js";
import { runResume } from "./commands/resume.js";
import { runRun } from "./commands/run.js";
import { runRuns } from "./commands/runs.js";
import { runSave } from "./commands/save.js";
import { runSecrets } from "./commands/secrets.js";
import { runTypes } from "./commands/types.js";
import { runUi } from "./commands/ui.js";
import type { CliContext } from "./context.js";
import { printLine, report } from "./output.js";
import { usage } from "./usage.js";

const COMMANDS: Record<string, (context: CliContext) => Promise<void>> = {
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
};

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals, triggerInput } = parseCliArgs(args);
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    printLine(usage());
    return;
  }
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
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
  main().catch((error: unknown) => {
    report(errorMessage(error));
    process.exitCode = 1;
  });
}
