import type { CommandOutput } from "../core/model.js";

export class RunBusyError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is already executing`);
    this.name = "RunBusyError";
  }
}

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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
