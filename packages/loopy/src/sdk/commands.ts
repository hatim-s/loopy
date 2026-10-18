import { commandKey } from "./define-command.js";
import { archiveDescriptors } from "./shell/archive.js";
import { fsDescriptors } from "./shell/fs.js";
import { gitDescriptors } from "./shell/git.js";
import { netDescriptors } from "./shell/net.js";
import { textDescriptors } from "./shell/text.js";

export { sdkCalls } from "./graph/index.js";

const builtins = [
  ...Object.values(archiveDescriptors),
  ...Object.values(fsDescriptors),
  ...Object.values(gitDescriptors),
  ...Object.values(netDescriptors),
  ...Object.values(textDescriptors),
];

export const builtinCommandKeys = builtins.map(commandKey);

export function commandParser(key: string) {
  const descriptor = builtins.find((value) => commandKey(value) === key);

  return descriptor && "parse" in descriptor ? descriptor.parse : undefined;
}
