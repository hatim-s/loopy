import type { CommandResult, ExecutionMode } from "../core/index.js";
import { CommandExecutionError } from "./errors.js";

export type ResolvedCommand = {
  program: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
};

export interface Executor {
  execute(
    command: ResolvedCommand,
    options: { timeoutMs?: number; cwd: string; mode: ExecutionMode },
  ): Promise<CommandResult>;
}

export class CommandExitError extends CommandExecutionError {
  constructor(result: CommandResult) {
    super(
      `Command exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}. Inspect stderr and correct the command.`,
      result,
      true,
    );
    this.name = "CommandExitError";
  }
}
