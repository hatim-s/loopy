import { macSandbox } from "./darwin.js";
import { linuxSandbox } from "./linux.js";

/** The platform's sandbox program and the argv prefix that runs `program` inside it. */
export async function sandboxLauncher(
  program: string,
  workspace: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  helper?: string,
): Promise<[string, string[]]> {
  if (process.platform === "darwin") {
    return macSandbox(program, workspace, env, helper);
  }
  if (process.platform === "linux") {
    return linuxSandbox(program, workspace, cwd, env, helper);
  }
  throw new Error(`Sandbox mode is unavailable on ${process.platform}.`);
}
