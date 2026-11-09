import { Effect } from "effect";
import { unstarted } from "../spawn";
import { sandboxTool, sbpl } from "./tool";

export const compilerLauncher = (program: string, cwd: string) =>
  Effect.gen(function* () {
    const tool = yield* sandboxTool();

    if (tool.kind === "darwin") {
      const profile = yield* Effect.try({
        try: () =>
          [
            "(version 1)",
            "(deny default)",
            "(allow process-exec)",
            "(allow sysctl-read)",
            "(allow file-read*)",
            `(allow file-write* (subpath ${sbpl(cwd)}))`,
            '(allow file-write* (literal "/dev/null"))',
            "(deny network*)",
          ].join("\n"),
        catch: unstarted,
      });

      return [tool.exec, ["-p", profile, program]] satisfies [string, string[]];
    }

    return [
      tool.bwrap,
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
  });
