#!/usr/bin/env bun

import { createDefaultProviderRegistry, type ProviderRegistry } from "@loopy/providers";
import { doctorCommand } from "./doctor";

export { doctorCommand, formatDoctor, runDoctor } from "./doctor";

const VERSION = "0.1.0";

const COMMANDS = [
  "init",
  "doctor",
  "providers",
  "sessions",
  "import",
  "extract",
  "validate",
  "run",
  "pause",
  "resume",
  "cancel",
  "retry",
  "fork",
  "replay",
  "trace",
  "ui",
] as const;

function printHelp(): void {
  console.log(`Loopy ${VERSION}

Local-first workflow runtime for coding agents.

Usage:
  loopy --version
  loopy --help
  loopy <command> [options]

Commands:
  ${COMMANDS.join(", ")}

Phase 0 status:
  The workspace and CLI shell are available. Product commands are not implemented yet.`);
}

export type CliDependencies = { registry?: ProviderRegistry };

export async function mainAsync(
  args: readonly string[] = Bun.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  if (args[0] === "doctor") {
    return doctorCommand(dependencies.registry ?? createDefaultProviderRegistry(), {
      json: args.includes("--json"),
      log: (line) => console.log(line),
    });
  }
  return main(args, dependencies);
}

export function main(
  args: readonly string[] = Bun.argv.slice(2),
  dependencies: CliDependencies = {},
): number {
  const [command] = args;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return 0;
  }

  if (command === "doctor") {
    // Keep the historical synchronous shell API while the executable awaits
    // the real async probe through `mainAsync` below.
    void mainAsync(args, dependencies).then((code) => {
      process.exitCode = code;
    });
    return 0;
  }

  console.error(`loopy: '${command}' is not implemented in this release.`);
  console.error("Run 'loopy --help' to see the planned command surface.");
  return 2;
}

if (import.meta.main) {
  process.exitCode = await mainAsync();
}
