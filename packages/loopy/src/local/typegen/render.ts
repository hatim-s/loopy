import type { CommandDescriptor } from "../../core/index.js";
import { isTypeScriptIdentifier } from "./names.js";

export function renderCommandSource(name: string, descriptor: CommandDescriptor): string {
  if (!isTypeScriptIdentifier(name)) {
    throw new Error(`'${name}' is not a valid TypeScript identifier.`);
  }
  return (
    `import { type CommandDescriptor, defineCommand } from "loopy";\n\n` +
    `const descriptor = ${JSON.stringify(descriptor, null, 2)} as const satisfies CommandDescriptor;\n\n` +
    `export const ${name} = defineCommand(descriptor);\n`
  );
}
