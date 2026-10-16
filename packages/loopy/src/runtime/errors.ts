import type { CommandOutput } from "../core/index.js";

/** `started` tells the runtime whether the command may have had side effects. */
export class CommandExecutionError extends Error {
  constructor(
    message: string,
    readonly output: CommandOutput,
    readonly started: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommandExecutionError";
  }
}
