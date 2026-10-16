import type { CommandDescriptor, FlagDefinition, PositionalDefinition } from "../../sdk/host.js";
import { isTypeScriptIdentifier } from "./names.js";

function key(name: string): string {
  return isTypeScriptIdentifier(name) ? name : JSON.stringify(name);
}

function descriptorObject(value: FlagDefinition | PositionalDefinition): string {
  return `{ ${Object.entries(value)
    .map(([name, entry]) => `${key(name)}: ${JSON.stringify(entry)}`)
    .join(", ")} }`;
}

export function renderCommandSource(name: string, descriptor: CommandDescriptor): string {
  if (!isTypeScriptIdentifier(name)) {
    throw new Error(`'${name}' is not a valid TypeScript identifier.`);
  }

  const fields = Object.entries(descriptor).map(([name, value]) => {
    if (name === "flags") {
      const flags = Object.entries(descriptor.flags ?? {}).map(
        ([flag, definition]) => `    ${key(flag)}: ${descriptorObject(definition)},`,
      );

      return flags.length ? `  flags: {\n${flags.join("\n")}\n  },` : "  flags: {},";
    }

    if (name === "positionals") {
      return `  positionals: [${descriptor.positionals?.map(descriptorObject).join(", ") ?? ""}],`;
    }

    return `  ${key(name)}: ${JSON.stringify(value)},`;
  });

  return (
    `import { type CommandDescriptor, defineCommand } from "loopy";\n\n` +
    `const descriptor = {\n${fields.join("\n")}\n} as const satisfies CommandDescriptor;\n\n` +
    `export const ${name} = defineCommand(descriptor);\n`
  );
}
