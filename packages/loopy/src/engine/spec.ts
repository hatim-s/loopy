import { durationMs, type ExecutionSpec, isStringArray, type Node } from "../core/index.js";
import { ROOT_CONTEXT, resolve, resolveValues } from "./resolve.js";
import type { EngineState } from "./state.js";

export function executionSpec(
  node: Extract<Node, { kind: "code" | "command" }>,
  state: EngineState,
  context = ROOT_CONTEXT,
): ExecutionSpec {
  if (node.kind === "code") {
    if (node.module.bundleHash === null) {
      throw new Error("Code bundle is missing. Save the graph again.");
    }

    return {
      kind: "code",
      bundleHash: node.module.bundleHash,
      input: resolveValues(node.in, state, context),
      timeoutMs: node.timeout === null ? 300_000 : durationMs(node.timeout),
    };
  }

  if (node.parse && node.parse.bundleHash === null) {
    throw new Error("Parser bundle is missing. Save the graph again.");
  }

  return {
    kind: "command",
    node,
    argv: node.argv.flatMap((value) => {
      const argument = resolve(value, state, context);

      if (Array.isArray(argument)) {
        if (!isStringArray(argument)) {
          throw new Error("Command argument arrays must contain only strings.");
        }

        return argument;
      }

      return [String(argument)];
    }),
    flags: resolveValues(node.flags, state, context),
    cwd: node.options.cwd === null ? null : String(resolve(node.options.cwd, state, context)),
    env: Object.fromEntries(
      Object.entries(resolveValues(node.options.env, state, context)).map(([key, value]) => [
        key,
        String(value),
      ]),
    ),
    stdin: node.options.stdin === null ? null : String(resolve(node.options.stdin, state, context)),
    parse: node.parse?.bundleHash
      ? {
          bundleHash: node.parse.bundleHash,
          input: resolveValues(node.parse.input, state, context),
        }
      : null,
  };
}
