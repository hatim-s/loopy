import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  durationMs,
  type ExecutionSpec,
  type Node,
  renderArgv,
} from "../core/index.js";
import { resolve, resolveValues } from "./resolve.js";
import type { EngineState } from "./state.js";

export function executionSpec(
  node: Extract<Node, { kind: "code" | "command" }>,
  state: EngineState,
): ExecutionSpec {
  if (node.kind === "code") {
    if (node.module.bundleHash === null) {
      throw new Error("Code bundle is missing. Save the graph again.");
    }

    return {
      kind: "code",
      bundleHash: node.module.bundleHash,
      input: resolveValues(node.in, state),
      timeoutMs: node.timeout === null ? DEFAULT_EXECUTION_TIMEOUT_MS : durationMs(node.timeout),
    };
  }

  if (node.parse && node.parse.bundleHash === null) {
    throw new Error("Parser bundle is missing. Save the graph again.");
  }

  const [program, ...args] = node.argv.map((value) => String(resolve(value, state)));

  if (!program) {
    throw new Error("Command argv is empty.");
  }

  return {
    kind: "command",
    argv: [
      program,
      ...renderArgv(
        { program, ...node.flagSpec },
        { args, flags: resolveValues(node.flags, state) },
        node.key,
      ),
    ],
    okExitCodes: node.okExitCodes,
    cwd: node.options.cwd === null ? null : String(resolve(node.options.cwd, state)),
    env: Object.fromEntries(
      Object.entries(resolveValues(node.options.env, state)).map(([key, value]) => [
        key,
        String(value),
      ]),
    ),
    stdin: node.options.stdin === null ? null : String(resolve(node.options.stdin, state)),
    parse: node.parse?.bundleHash
      ? { bundleHash: node.parse.bundleHash, input: resolveValues(node.parse.input, state) }
      : null,
  };
}
