import type { Json } from "../core/index.js";
import type { Duration, LoopyContext, StepContext, StepOptions } from "../runtime/index.js";
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

export function command(...args: Parameters<LoopyContext["command"]>) {
  return workflowContext().command(...args);
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
