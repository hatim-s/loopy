import { CALL_SYNTAX, type CallSyntax, COMMAND_CALL } from "./calls";
import { type CommandDescriptor, commandKey } from "./descriptor";
import * as graph from "./graph";
import { PARSER, type Parser } from "./graph/nodes/command";
import { GraphBuildError } from "./graph/validate";
import * as fsParsers from "./shell/parse/fs";
import * as gitParsers from "./shell/parse/git";
import * as netParsers from "./shell/parse/net";
import * as textParsers from "./shell/parse/text";

export { type CallSyntax, COMMAND_CALL, type OptionRole } from "./calls";

export { commandKey } from "./descriptor";

type Builtin = { readonly descriptor: CommandDescriptor; readonly [PARSER]?: Parser<unknown> };

type Namespace = { readonly [name: string]: Builtin | Namespace };

function isBuiltin(value: Builtin | Namespace): value is Builtin {
  return "descriptor" in value;
}

function builtinsOf(namespace: Namespace, prefix: string): { path: string; call: Builtin }[] {
  return Object.entries(namespace).flatMap(([name, value]) =>
    isBuiltin(value)
      ? [{ path: `${prefix}.${name}`, call: value }]
      : builtinsOf(value, `${prefix}.${name}`),
  );
}

const NAMESPACES = {
  archive: graph.archive,
  fs: graph.fs,
  git: graph.git,
  net: graph.net,
  text: graph.text,
};

const builtins = Object.entries(NAMESPACES).flatMap(([name, namespace]) =>
  builtinsOf(namespace, name),
);

/** Every callable author path, such as `git.stash.list.raw`, with the rules for its arguments. */
export const sdkCalls: ReadonlyMap<string, CallSyntax> = new Map<string, CallSyntax>([
  ...Object.entries(CALL_SYNTAX).filter(([name]) => !Object.hasOwn(NAMESPACES, name)),
  ...Object.keys(graph.sh).map((member) => [`sh.${member}`, CALL_SYNTAX.sh] as const),
  ...builtins.flatMap(({ path }) => [
    [path, COMMAND_CALL] as const,
    [`${path}.raw`, COMMAND_CALL] as const,
  ]),
]);

export const builtinCommandKeys = builtins.map(({ call }) => commandKey(call.descriptor));

const PARSER_MODULES = [
  ["./shell/parse/fs", fsParsers],
  ["./shell/parse/git", gitParsers],
  ["./shell/parse/net", netParsers],
  ["./shell/parse/text", textParsers],
] as const;

/** Locates a built-in parser so the compiler can bundle it without knowing the SDK layout. */
export function builtinParser(key: string) {
  const parse = builtins.find(({ call }) => commandKey(call.descriptor) === key)?.call[PARSER];

  for (const [specifier, exports] of PARSER_MODULES) {
    const exportName = Object.entries(exports).find(([, value]) => value === parse)?.[0];

    if (parse && exportName) {
      return { file: Bun.resolveSync(specifier, import.meta.dir), exportName };
    }
  }

  return undefined;
}

/** The evaluator protocol: graph JSON on stdout, or the build diagnostic on stderr. */
export async function emitGraph(load: () => Promise<{ default: unknown }>) {
  try {
    const { default: built } = await load();
    process.stdout.write(JSON.stringify(built));
  } catch (error) {
    process.stderr.write(
      error instanceof GraphBuildError ? JSON.stringify(error.diagnostic) : String(error),
    );
    process.exitCode = 1;
  }
}
