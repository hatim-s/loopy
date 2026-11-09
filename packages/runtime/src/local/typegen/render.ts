import { isBoolean, isNumber, isString } from "@loopy/core";
import type { CommandDescriptor } from "@loopy/sdk/host";
import { isTypeScriptIdentifier } from "./names";

type Printable = string | number | boolean | readonly Field[] | { readonly [key: string]: Field };

/** Optional descriptor properties may hold undefined, which the printer omits. */
type Field = Printable | undefined;

const LINE_WIDTH = 100;

function key(name: string): string {
  return isTypeScriptIdentifier(name) ? name : JSON.stringify(name);
}

/** Prints a value inline when it fits on one line, otherwise one entry per line. */
function print(value: Printable, indent: string): string {
  if (isString(value) || isNumber(value) || isBoolean(value)) {
    return JSON.stringify(value);
  }

  const inner = `${indent}  `;
  const list = Array.isArray(value);

  const items = Array.isArray(value)
    ? value.flatMap((item: Field) => (item === undefined ? [] : [print(item, inner)]))
    : Object.entries(value).flatMap(([name, item]) =>
        item === undefined ? [] : [`${key(name)}: ${print(item, inner)}`],
      );

  if (items.length === 0) {
    return list ? "[]" : "{}";
  }

  const inline = list ? `[${items.join(", ")}]` : `{ ${items.join(", ")} }`;

  if (!inline.includes("\n") && indent.length + inline.length <= LINE_WIDTH) {
    return inline;
  }

  const lines = items.map((item) => `${inner}${item},`).join("\n");

  return list ? `[\n${lines}\n${indent}]` : `{\n${lines}\n${indent}}`;
}

/** The descriptor sits inline in the defineCommand call, which the restricted compiler requires. */
export function renderCommandSource(name: string, descriptor: CommandDescriptor): string {
  if (!isTypeScriptIdentifier(name)) {
    throw new Error(`'${name}' is not a valid TypeScript identifier.`);
  }

  return `import { defineCommand } from "loopy";

export const ${name} = defineCommand(${print(descriptor, "")});
`;
}
