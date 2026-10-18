import type { CommandResult } from "./model.js";

export class CommandExecutionError extends Error {
  constructor(
    message: string,
    readonly output: CommandResult,
    options?: ErrorOptions,
    readonly code: "execution" | "output_limit" = "execution",
  ) {
    super(message, options);
    this.name = "CommandExecutionError";
  }
}

export type ResolvedCommand = {
  program: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
};
