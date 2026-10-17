import type { CommandDescriptor } from "./define-command.js";
import { platformVariant } from "./define-command.js";
import { archive } from "./shell/archive.js";
import { fs } from "./shell/fs.js";
import { git } from "./shell/git.js";
import { net } from "./shell/net.js";
import { text } from "./shell/text.js";

type Commands = { [key: string]: Commands | { descriptor: CommandDescriptor } };

function hasDescriptor(
  value: Commands | { descriptor: CommandDescriptor },
): value is { descriptor: CommandDescriptor } {
  return (
    "descriptor" in value &&
    "program" in value.descriptor &&
    typeof value.descriptor.program === "string"
  );
}

function descriptors(commands: Commands): CommandDescriptor[] {
  return Object.values(commands).flatMap((value) =>
    hasDescriptor(value) ? [value.descriptor] : descriptors(value),
  );
}

const builtins = descriptors({ archive, fs, git, net, text });

export const builtinCommandKeys = builtins.map(
  (value) => value.key ?? `${value.namespace}.${value.name}`,
);

export function commandParser(key: string, platform: string) {
  const descriptor = builtins.find(
    (value) => (value.key ?? `${value.namespace}.${value.name}`) === key,
  );

  const parse = descriptor === undefined ? undefined : platformVariant(descriptor, platform).parse;

  if (!parse) {
    throw new Error(`No parser for '${key}'.`);
  }

  return parse;
}
