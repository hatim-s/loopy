import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { Effect } from "effect";
import type { CommandExecutionError } from "../command-error";
import { rejected, unstarted } from "../spawn";
import type { ProcessFilesystemError } from "./io";
import { filesystem } from "./io";
import type { SandboxOptions } from "./launcher";
import { ENV_EXEC, envArgs, packageDirectory, within } from "./paths";
import { sbpl } from "./tool";

/**
 * Hides the user's home and denies network access. The workspace and scratch
 * directory are writable; the program and its package stay readable under home.
 */
export function macSandbox(
  exec: string,
  { program, workspace, env, scratch, helper, protectedHome, mode }: SandboxOptions,
) {
  return Effect.gen(function* (): Effect.fn.Return<
    [string, string[]],
    CommandExecutionError | ProcessFilesystemError
  > {
    const environmentArgs = yield* Effect.try({ try: () => envArgs(env), catch: rejected });

    const home = yield* filesystem(() => realpath(homedir()));

    const allowedPackage = within(workspace, program)
      ? undefined
      : yield* packageDirectory(program, home);

    const profile = yield* Effect.try({
      try: () =>
        [
          "(version 1)",
          mode === "full" ? "(allow default)" : "(deny default)",
          "(allow process-exec)",
          "(allow process-fork)",
          "(allow sysctl-read)",
          "(allow file-read*)",
          ...(mode === "sandbox" && !within(workspace, home)
            ? [`(deny file-read* (subpath ${sbpl(home)}))`]
            : []),
          `(allow file-read* (subpath ${sbpl(workspace)}))`,
          `(allow file-read* (literal ${sbpl(program)}))`,
          ...(helper ? [`(allow file-read* (literal ${sbpl(helper)}))`] : []),
          ...(allowedPackage ? [`(allow file-read* (subpath ${sbpl(allowedPackage)}))`] : []),
          `(allow file-read* (subpath ${sbpl(scratch)}))`,
          `(allow file-write* (subpath ${sbpl(scratch)}))`,
          `(allow file-write* (subpath ${sbpl(workspace)}))`,
          '(allow file-write* (literal "/dev/null") (literal "/dev/tty"))',
          '(allow file-read* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty"))',
          `(deny file-read* file-write* (subpath ${sbpl(protectedHome)}))`,
          ...(mode === "full" ? [] : ["(deny network*)"]),
        ].join("\n"),
      catch: unstarted,
    });

    return [exec, ["-p", profile, ENV_EXEC, "-i", "--", ...environmentArgs, helper ?? program]];
  });
}
