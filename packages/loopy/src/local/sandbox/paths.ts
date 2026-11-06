import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import { errnoCode } from "../../core";
import { rejected } from "../spawn";
import { absentPath, filesystem } from "./io";

export const ENV_EXEC = "/usr/bin/env";

/** True when child is parent or lives below it. */
export function within(parent: string, child: string): boolean {
  const path = relative(parent, child);

  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export const executable = Effect.fn(function* (path: string) {
  return yield* Effect.gen(function* () {
    yield* filesystem(() => access(path, constants.X_OK));

    return (yield* filesystem(() => stat(path))).isFile();
  }).pipe(Effect.catchIf(absentPath, () => Effect.succeed(false)));
});

/** Resolve an executable against the command directory and its PATH. */
export const resolveProgram = Effect.fn(function* (program: string, cwd: string, path: string) {
  const candidates = program.includes(sep)
    ? [resolve(cwd, program)]
    : path.split(delimiter).map((directory) => resolve(cwd, directory, program));

  for (const candidate of candidates) {
    if (
      yield* executable(candidate).pipe(
        Effect.catchIf(
          (error) => errnoCode(error.cause) === "ELOOP",
          (error) => Effect.fail(rejected(error.cause)),
        ),
      )
    ) {
      return yield* filesystem(() => realpath(candidate));
    }
  }

  return yield* Effect.fail(rejected(new Error(`Executable '${program}' was not found.`)));
});

/** The nearest package root above a program inside home, if any. */
export const packageDirectory = Effect.fn(function* (program: string, home: string) {
  if (!within(home, program)) {
    return undefined;
  }

  for (let directory = dirname(program); within(home, directory) && directory !== home; ) {
    const path = join(directory, "package.json");

    const exists = yield* filesystem(() => access(path)).pipe(
      Effect.as(true),
      Effect.catchIf(absentPath, () => Effect.succeed(false)),
    );

    if (exists) {
      return directory;
    }

    directory = dirname(directory);
  }

  return undefined;
});

/** Reject environment names or values that split or truncate launcher arguments. */
export function envArgs(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).map(([name, value]) => {
    if (!name || name.includes("=") || name.includes("\0") || value?.includes("\0")) {
      throw new Error(`'${name}' is not a valid command environment variable name.`);
    }

    return `${name}=${value ?? ""}`;
  });
}
