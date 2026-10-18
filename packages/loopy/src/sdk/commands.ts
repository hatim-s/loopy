import { type CommandDescriptor, commandKey } from "./define-command.js";
import * as api from "./graph/api.js";
import { archiveDescriptors } from "./shell/archive.js";
import { fsDescriptors } from "./shell/fs.js";
import { gitDescriptors } from "./shell/git.js";
import { netDescriptors } from "./shell/net.js";
import { textDescriptors } from "./shell/text.js";

const builtins: CommandDescriptor[] = [
  ...Object.values(archiveDescriptors),
  ...Object.values(fsDescriptors),
  ...Object.values(gitDescriptors),
  ...Object.values(netDescriptors),
  ...Object.values(textDescriptors),
];

export const builtinCommandKeys = builtins.map(commandKey);

export function commandParser(key: string) {
  return builtins.find((value) => commandKey(value) === key)?.parse;
}

type SdkFunction = (...args: never[]) => void;

type SdkMember = SdkFunction | { [name: string]: SdkMember };

function isFunction(value: SdkMember): value is SdkFunction {
  return typeof value === "function";
}

function calls(value: SdkMember, prefix = "", ancestors = new Set<SdkMember>()): string[] {
  const seen = new Set(ancestors).add(value);
  const entries: [string, SdkMember][] = Object.entries(value);

  return entries.flatMap(([key, member]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    if (isFunction(member)) {
      return [path, ...(seen.has(member) ? [] : calls(member, path, seen))];
    }

    return calls(member, path, seen);
  });
}

export const sdkCalls = calls(api);
