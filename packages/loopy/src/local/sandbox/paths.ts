import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const ENV_EXEC = "/usr/bin/env";

/** True when `child` is `parent` or lives below it. */
export function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The real path of `program`, searched on `path` unless it already names a directory. */
export async function resolveProgram(program: string, cwd: string, path: string): Promise<string> {
  const candidates = program.includes(sep)
    ? [resolve(cwd, program)]
    : path.split(delimiter).map((directory) => resolve(cwd, directory, program));
  for (const candidate of candidates) {
    if (await executable(candidate)) {
      return realpath(candidate);
    }
  }
  throw new Error(`Executable '${program}' was not found.`);
}

/** The nearest package root above a program inside the home directory, if any. */
export async function packageDirectory(program: string, home: string): Promise<string | undefined> {
  if (!within(home, program)) {
    return undefined;
  }
  for (let directory = dirname(program); within(home, directory) && directory !== home; ) {
    try {
      await access(join(directory, "package.json"));
      return directory;
    } catch {
      directory = dirname(directory);
    }
  }
  return undefined;
}

/** `NAME=value` pairs for `env -i`, rejecting names that would split or truncate. */
export function envArgs(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).map(([name, value]) => {
    if (!name || name.includes("=") || name.includes("\0") || value?.includes("\0")) {
      throw new Error(`'${name}' is not a valid command environment variable name.`);
    }
    return `${name}=${value ?? ""}`;
  });
}
