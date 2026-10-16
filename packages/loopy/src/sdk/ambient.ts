import type { CommandResult, Json } from "../core/index.js";
import type { Duration, ResolvedCommand, StepContext, StepOptions } from "../runtime/index.js";
import { current, workflowContext } from "./current.js";

export function step<T extends Json>(
  key: string,
  fn: (context: StepContext) => T | Promise<T>,
  options?: StepOptions,
): Promise<T> {
  return workflowContext().step(key, fn, options);
}

export function sleep(duration: Duration): Promise<void> {
  return workflowContext().sleep(duration);
}

export function now(): Promise<number> {
  return workflowContext().now();
}

export function random(): Promise<number> {
  return workflowContext().random();
}

export function uuid(): Promise<string> {
  return workflowContext().uuid();
}

export function command(
  key: string,
  command: ResolvedCommand,
  options?: StepOptions,
): Promise<CommandResult>;
export function command<T extends Json>(
  key: string,
  command: ResolvedCommand,
  options: StepOptions | undefined,
  parse: (result: CommandResult) => T,
): Promise<T>;
export function command(
  key: string,
  command: ResolvedCommand,
  options?: StepOptions,
  parse?: (result: CommandResult) => Json,
): Promise<Json> {
  if (parse) {
    return workflowContext().command(key, command, options, parse);
  }

  return workflowContext().command(key, command, options);
}

export const log = {
  info(message: string, data?: Json) {
    current().log.info(message, data);
  },
  warn(message: string, data?: Json) {
    current().log.warn(message, data);
  },
  error(message: string, data?: Json) {
    current().log.error(message, data);
  },
};
