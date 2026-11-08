// Every command the page shows. Each name must match a command in packages/cli/src/commands.
type Command = { name: `loopy ${string}`; args?: string };

export const INSTALL = "bun add -g loopy";

export const COMMANDS = {
  save: { name: "loopy save", args: "cve-patch.loopy.ts" },
  graph: { name: "loopy graph", args: "cve-patch" },
  run: { name: "loopy run", args: "cve-patch" },
  ui: { name: "loopy ui" },
} as const satisfies Record<string, Command>;

export const example = ({ name, args }: Command) => (args ? `${name} ${args}` : name);
