import { type ExecutionSpec, renderCommandArgv } from "@loopy/core";

export { CommandExecutionError, type ResolvedCommand } from "./command-error";

export { executeLocalCommand } from "./process";

export { withBundleSandbox } from "./sandbox/bundle";

export { secretRedactor } from "./secret-redactor";

export { SecretStore } from "./secrets";

export { spawnCaptured } from "./spawn";

export function renderCommand(
  spec: Extract<ExecutionSpec, { kind: "command" }>,
): [string, ...string[]] {
  const [program = "", ...operands] = spec.argv;

  return [program, ...renderCommandArgv(spec.node.flagSpec, operands, spec.flags)];
}
