import {
  CommandArgumentError,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  durationMs,
  type ExecutionError,
  type ExecutionSpec,
  type Node,
  renderArgv,
} from "../core/index.js";
import { resolve, resolveValues } from "./resolve.js";
import type { EngineState } from "./state.js";

export const MISSING_INPUT: ExecutionError = {
  code: "validation",
  message: "A reference has no completed output.",
};

export function executionSpec(
  node: Extract<Node, { kind: "code" | "command" }>,
  state: EngineState,
): ExecutionSpec | ExecutionError {
  if (node.kind === "code") {
    if (node.module.bundleHash === null) {
      return { code: "validation", message: "Code bundle is missing. Save the graph again." };
    }

    const input = resolveValues(node.in, state);

    return input === undefined
      ? MISSING_INPUT
      : {
          kind: "code",
          bundleHash: node.module.bundleHash,
          input,
          timeoutMs:
            node.timeout === null ? DEFAULT_EXECUTION_TIMEOUT_MS : durationMs(node.timeout),
        };
  }

  if (node.parse && node.parse.bundleHash === null) {
    return { code: "validation", message: "Parser bundle is missing. Save the graph again." };
  }

  const argv = node.argv.map((value) => resolve(value, state));
  const flags = resolveValues(node.flags, state);
  const env = resolveValues(node.options.env, state);
  const cwd = resolve(node.options.cwd, state);
  const stdin = resolve(node.options.stdin, state);
  const input = resolveValues(node.parse?.input ?? {}, state);

  if (
    argv.includes(undefined) ||
    flags === undefined ||
    env === undefined ||
    cwd === undefined ||
    stdin === undefined ||
    input === undefined
  ) {
    return MISSING_INPUT;
  }

  const [program, ...args] = argv.map(String);

  if (!program) {
    return { code: "validation", message: "Command argv is empty." };
  }

  let rendered: string[];

  try {
    rendered = renderArgv({ program, ...node.flagSpec }, { args, flags }, node.key);
  } catch (cause) {
    if (cause instanceof CommandArgumentError) {
      return { code: "validation", message: cause.message };
    }

    throw cause;
  }

  return {
    kind: "command",
    argv: [program, ...rendered],
    okExitCodes: node.okExitCodes,
    cwd: cwd === null ? null : String(cwd),
    env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])),
    stdin: stdin === null ? null : String(stdin),
    parse: node.parse?.bundleHash ? { bundleHash: node.parse.bundleHash, input: input } : null,
  };
}
