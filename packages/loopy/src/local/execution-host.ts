import type { ExecutionSpec } from "../core/index.js";
import { renderArgv } from "../sdk/host.js";

export { executeLocalCommand } from "./process.js";

export { bundleLauncher } from "./sandbox/bundle.js";

export { secretRedactor } from "./secret-redactor.js";

export { SecretStore } from "./secrets.js";

export { spawnCaptured } from "./spawn.js";

export function renderCommand(spec: Extract<ExecutionSpec, { kind: "command" }>) {
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
