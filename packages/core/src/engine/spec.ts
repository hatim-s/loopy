import { durationMs } from "../duration";
import { DEFAULT_TIMEOUT_MS, type ExecutionSpec } from "../executor";
import type { Node } from "../graph/nodes";
import { bundleHash, carriesBundle } from "../revision";
import { isStringArray } from "../validation";
import { type ResolutionContext, ROOT_CONTEXT, resolve, resolveValues } from "./resolve";
import type { EngineState } from "./state";

type CommandNode = Extract<Node, { kind: "command" }>;

function commandArgv(node: CommandNode, state: EngineState, context: ResolutionContext) {
  const [program, ...operands] = node.argv.flatMap((value) => {
    const argument = resolve(value, state, context);

    if (Array.isArray(argument)) {
      if (!isStringArray(argument)) {
        throw new Error("Command argument arrays must contain only strings.");
      }

      return argument;
    }

    return [String(argument)];
  });

  if (program === undefined) {
    throw new Error("Command argv is empty. Supply a program to run.");
  }

  return [program, ...operands] satisfies [string, ...string[]];
}

export function executionSpec(
  node: Extract<Node, { kind: "code" | "command" }>,
  state: EngineState,
  context = ROOT_CONTEXT,
): ExecutionSpec {
  if (node.kind === "code") {
    return {
      kind: "code",
      bundleHash: bundleHash(node),
      input: resolveValues(node.in, state, context),
      timeoutMs: node.timeout === null ? DEFAULT_TIMEOUT_MS : durationMs(node.timeout),
    };
  }

  const { options } = node;

  return {
    kind: "command",
    key: node.key,
    argv: commandArgv(node, state, context),
    flags: resolveValues(node.flags, state, context),
    flagSpec: node.flagSpec ?? null,
    variants: node.variants ?? {},
    cwd: options.cwd === null ? null : String(resolve(options.cwd, state, context)),
    env: Object.fromEntries(
      Object.entries(resolveValues(options.env, state, context)).map(([key, value]) => [
        key,
        String(value),
      ]),
    ),
    stdin: options.stdin === null ? null : String(resolve(options.stdin, state, context)),
    timeoutMs: options.timeout === undefined ? DEFAULT_TIMEOUT_MS : durationMs(options.timeout),
    maxOutputBytes: options.maxOutputBytes ?? null,
    okExitCodes: [...node.okExitCodes],
    parse: carriesBundle(node)
      ? { bundleHash: bundleHash(node), timeoutMs: DEFAULT_TIMEOUT_MS }
      : null,
  };
}
