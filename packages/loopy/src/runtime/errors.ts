import type { CommandOutput } from "../core/model.js";

export class RunBusyError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is already executing`);
    this.name = "RunBusyError";
  }
}

export class CommandExecutionError extends Error {
  readonly output: CommandOutput;
  readonly started: boolean;

  constructor(message: string, output: CommandOutput, started: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandExecutionError";
    this.output = output;
    this.started = started;
  }
}
