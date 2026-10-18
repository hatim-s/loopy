import { archive, fs, git, net, text } from "./graph/index.js";

export { sdkCalls } from "./graph/index.js";

type Descriptor = { key?: string; namespace?: string; name?: string; parse?: string };

type Commands = { [key: string]: Commands | { descriptor: Descriptor } };

function hasDescriptor(
  value: Commands | { descriptor: Descriptor },
): value is { descriptor: Descriptor } {
  return "descriptor" in value && "program" in value.descriptor;
}

function descriptors(commands: Commands): Descriptor[] {
  return Object.values(commands).flatMap((value) =>
    hasDescriptor(value) ? [value.descriptor] : descriptors(value),
  );
}

const builtins = descriptors({ archive, fs, git, net, text });

export function commandKey(descriptor: Descriptor) {
  return descriptor.key ?? `${descriptor.namespace}.${descriptor.name}`;
}

export const builtinCommandKeys = builtins.map(commandKey);

export function commandParser(key: string) {
  return builtins.find((value) => commandKey(value) === key)?.parse;
}
