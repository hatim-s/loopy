import { errorMessage } from "@loopy/core";
import { CALL_SYNTAX, type CallSyntax, COMMAND_CALL } from "./calls";
import * as graph from "./graph";
import { GraphBuildError } from "./graph/validate";
import { BUILTIN, type Hosted } from "./shell/builtin";
import * as parsers from "./shell/parse";

export { type CallSyntax, COMMAND_CALL } from "./calls";

export { GraphBuildError } from "./graph/validate";

type Namespace = { readonly [name: string]: Hosted | Namespace };

function builtinsOf(namespace: Namespace): Hosted[typeof BUILTIN][] {
  return Object.values(namespace).flatMap((value) =>
    BUILTIN in value ? [value[BUILTIN]] : builtinsOf(value),
  );
}

type NamespaceName = {
  [K in keyof typeof CALL_SYNTAX]: (typeof CALL_SYNTAX)[K] extends "namespace" ? K : never;
}[keyof typeof CALL_SYNTAX];

// The mapped key type keeps this list equal to the namespaces the call table marks.
const NAMESPACES = {
  archive: graph.archive,
  fs: graph.fs,
  git: graph.git,
  net: graph.net,
  text: graph.text,
} satisfies { readonly [K in NamespaceName]: Namespace };

const builtins = Object.values(NAMESPACES).flatMap(builtinsOf);

/** Every callable author path, such as `git.stash.list.raw`, with the rules for its arguments. */
export const sdkCalls: ReadonlyMap<string, CallSyntax> = new Map<string, CallSyntax>([
  ...Object.entries(CALL_SYNTAX).flatMap(([name, syntax]) =>
    syntax === "namespace" ? [] : [[name, syntax] as const],
  ),
  ...Object.keys(graph.sh).map((member) => [`sh.${member}`, CALL_SYNTAX.sh] as const),
  ...builtins.flatMap(({ key }) => [
    [key, COMMAND_CALL] as const,
    [`${key}.raw`, COMMAND_CALL] as const,
  ]),
]);

const parserNames = new Map<unknown, string>(
  Object.entries(parsers).map(([name, parse]) => [parse, name]),
);

/** Locates a built-in parser so the compiler can bundle it without knowing the SDK layout. */
export function builtinParser(key: string) {
  const parse = builtins.find((command) => command.key === key)?.parse;
  const exportName = parse ? parserNames.get(parse) : undefined;

  return exportName === undefined
    ? undefined
    : { file: Bun.resolveSync("./shell/parse", import.meta.dir), exportName };
}

/** The evaluator entry imports this module by path, so the compiler resolves no SDK package. */
export function evaluatorSource(file: string) {
  return `import {emitGraph} from ${JSON.stringify(import.meta.path)};
await emitGraph(() => import(${JSON.stringify(file)}));`;
}

/** The module that author SDK imports resolve to while the evaluator bundle is built. */
export function graphEntry() {
  return Bun.resolveSync("./graph", import.meta.dir);
}

/** The evaluator protocol: graph JSON on stdout, or the build diagnostic on stderr. */
export async function emitGraph(load: () => Promise<{ default: unknown }>) {
  try {
    const { default: built } = await load();
    process.stdout.write(JSON.stringify(built));
  } catch (error) {
    process.stderr.write(
      error instanceof GraphBuildError ? JSON.stringify(error.diagnostic) : errorMessage(error),
    );
    process.exitCode = 1;
  }
}
