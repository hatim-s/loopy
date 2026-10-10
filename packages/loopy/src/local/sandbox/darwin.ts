import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { ENV_EXEC, envArgs, executable, packageDirectory, within } from "./paths.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

const CONTROL_CHARACTERS = /[\0\n\r]/;

/** Quotes a path for a Sandbox Profile Language literal. */
function sbpl(path: string): string {
  if (CONTROL_CHARACTERS.test(path)) {
    throw new Error("Paths with control characters cannot be sandboxed.");
  }

  return JSON.stringify(path);
}

/**
 * Read-everything except the home directory, write only inside the workspace,
 * no network. The program and its package stay readable even under home.
 */
export async function macSandbox(
  program: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  helper?: string,
): Promise<[string, string[]]> {
  if (!(await executable(SANDBOX_EXEC))) {
    throw new Error("Sandbox mode requires /usr/bin/sandbox-exec on macOS.");
  }

  const home = await realpath(homedir());

  const allowedPackage = within(workspace, program)
    ? undefined
    : await packageDirectory(program, home);

  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    ...(within(workspace, home) ? [] : [`(deny file-read* (subpath ${sbpl(home)}))`]),
    `(allow file-read* (subpath ${sbpl(workspace)}))`,
    `(allow file-read* (literal ${sbpl(program)}))`,
    ...(helper ? [`(allow file-read* (literal ${sbpl(helper)}))`] : []),
    ...(allowedPackage ? [`(allow file-read* (subpath ${sbpl(allowedPackage)}))`] : []),
    `(allow file-write* (subpath ${sbpl(workspace)}))`,
    "(deny network*)",
  ].join("\n");

  return [SANDBOX_EXEC, ["-p", profile, ENV_EXEC, "-i", "--", ...envArgs(env), helper ?? program]];
}
