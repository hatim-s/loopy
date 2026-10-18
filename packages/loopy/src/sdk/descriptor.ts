import type { CommandDescriptor } from "./define-command.js";

export function descriptorCommand<const D extends CommandDescriptor>(descriptor: D) {
  return { descriptor };
}

export type { CommandDescriptor } from "./define-command.js";
