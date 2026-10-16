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
    options: { timeoutMs?: number; workspace: string; mode: ExecutionMode; signal?: AbortSignal },
  ): Promise<CommandResult>;
}

export class CommandExitError extends CommandExecutionError {
  constructor(result: CommandResult) {
    const stderr = result.stderr.slice(-500).trim();

    const detail = stderr
      ? `: ${stderr}. Inspect stderr and correct the command.`
      : ". Correct the command.";

    super(`Command exited with code ${result.exitCode}${detail}`, result, true);
    this.name = "CommandExitError";
  }
}
