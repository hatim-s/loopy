import type { ExecutionSpec } from "@loopy/core";
import { renderArgv } from "@loopy/sdk/host";

export { CommandExecutionError, type ResolvedCommand } from "./command-error";

export { executeLocalCommand } from "./process";

export { withBundleSandbox } from "./sandbox/bundle";

export { secretRedactor } from "./secret-redactor";

export { SecretStore } from "./secrets";

export { spawnCaptured } from "./spawn";

export function renderCommand(
  spec: Extract<ExecutionSpec, { kind: "command" }>,
): [string, ...string[]] {
  const [program, ...args] = spec.argv;

  return [
    program ?? "",
    ...renderArgv(
      { program: program ?? "", ...spec.node.flagSpec },
      { args, flags: spec.flags },
      spec.node.key,
    ),
  ];
}
