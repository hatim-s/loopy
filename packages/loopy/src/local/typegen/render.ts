import type { CommandFlag } from "../../core/index.js";
import type { PositionalDefinition } from "../../sdk/define-command.js";
import { ServiceError } from "../service-error.js";
import { isTypeScriptIdentifier } from "./names.js";
import type { GeneratedCommandDescriptor } from "./parse-help.js";

function key(name: string): string {
  return isTypeScriptIdentifier(name) ? name : JSON.stringify(name);
}

function descriptorObject(value: CommandFlag | PositionalDefinition): string {
  return `{ ${Object.entries(value)
    .map(([name, entry]) => `${key(name)}: ${JSON.stringify(entry)}`)
    .join(", ")} }`;
}

export function renderCommandSource(name: string, descriptor: GeneratedCommandDescriptor): string {
  if (!isTypeScriptIdentifier(name)) {
    throw new ServiceError("bad_request", `'${name}' is not a valid TypeScript identifier.`);
  }

  const { helpHash, observedVersion, ...command } = descriptor;

  const fields = Object.entries(command).map(([name, value]) => {
    if (name === "flags") {
      const flags = Object.entries(descriptor.flags ?? {}).map(
        ([flag, definition]) => `    ${key(flag)}: ${descriptorObject(definition)},`,
      );

      return flags.length ? `  flags: {\n${flags.join("\n")}\n  },` : "  flags: {},";
    }

    return `  ${key(name)}: ${JSON.stringify(value)},`;
  });

  return (
    `import { type CommandDescriptor, defineCommand } from "loopy";\n\n` +
    `export const ${name} = defineCommand({\n${fields.join("\n")}\n} as const satisfies CommandDescriptor);\n\n` +
    `export const ${name}Help = ${JSON.stringify({ helpHash, observedVersion })} as const;\n`
  );
}
