import type { ExecutionMode } from "@loopy/core";
import { Effect } from "effect";
import { macSandbox } from "./darwin";
import { linuxSandbox } from "./linux";
import { sandboxTool } from "./tool";

export type SandboxOptions = {
  program: string;
  workspace: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  scratch: string;
  helper?: string;
  protectedHome: string;
  mode: ExecutionMode;
};

export function sandboxLauncher(options: SandboxOptions) {
  return Effect.gen(function* () {
    const tool = yield* sandboxTool();

    return tool.kind === "darwin"
      ? yield* macSandbox(tool.exec, options)
      : yield* linuxSandbox(tool.bwrap, options);
  });
}
