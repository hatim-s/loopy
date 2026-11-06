import { Data, Effect } from "effect";
import { executable } from "./sandbox/paths";

export class CompilerLauncherError extends Data.TaggedError("CompilerLauncherError")<{
  message: string;
}> {}

export const compilerLauncher = (program: string, cwd: string) =>
  Effect.gen(function* () {
    if (process.platform === "darwin" && (yield* executable("/usr/bin/sandbox-exec"))) {
      const profile = [
        "(version 1)",
        "(deny default)",
        "(allow process-exec)",
        "(allow sysctl-read)",
        "(allow file-read*)",
        `(allow file-write* (subpath ${JSON.stringify(cwd)}))`,
        '(allow file-write* (literal "/dev/null"))',
        "(deny network*)",
      ].join("\n");

      return ["/usr/bin/sandbox-exec", ["-p", profile, program]] satisfies [string, string[]];
    }

    if (process.platform === "linux" && (yield* executable("/usr/bin/bwrap"))) {
      return [
        "/usr/bin/bwrap",
        [
          "--die-with-parent",
          "--unshare-all",
          "--ro-bind",
          "/",
          "/",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--bind",
          cwd,
          cwd,
          "--chdir",
          cwd,
          "--",
          program,
        ],
      ] satisfies [string, string[]];
    }

    return yield* Effect.fail(
      new CompilerLauncherError({
        message: "The compiler requires sandbox-exec on macOS or bubblewrap on Linux.",
      }),
    );
  });
