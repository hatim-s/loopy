import type { ExecutionMode } from "../../core/index.js";
import { macSandbox } from "./darwin.js";
import { linuxSandbox } from "./linux.js";

export type SandboxOptions = {
  program: string;
  workspace: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  scratch: string;
  helper?: string;
  protectedHome?: string;
  mode: ExecutionMode;
};

export async function sandboxLauncher(options: SandboxOptions): Promise<[string, string[]]> {
  if (process.platform === "darwin") {
    return macSandbox(options);
  }

  if (process.platform === "linux") {
    return linuxSandbox(options);
  }

  throw new Error(`Sandbox mode is unavailable on ${process.platform}.`);
}
