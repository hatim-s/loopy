import { stat } from "node:fs/promises";
import { Effect } from "effect";
import type { CommandExecutionError } from "../../core";
import type { BundleSandboxOptions } from "./bundle";
import type { ProcessFilesystemError } from "./io";
import { absentPath, filesystem } from "./io";

export function linuxBundle({ bundle, workspace, bun, network, home }: BundleSandboxOptions) {
  return Effect.gen(function* (): Effect.fn.Return<
    [string, string[]],
    CommandExecutionError | ProcessFilesystemError
  > {
    const args = ["--die-with-parent", "--unshare-all", "--cap-drop", "ALL"];

    if (network) {
      args.push("--share-net");
    }

    for (const directory of ["/usr/lib", "/lib", "/lib64"]) {
      if (
        yield* filesystem(() => stat(directory)).pipe(
          Effect.as(true),
          Effect.catchIf(absentPath, () => Effect.succeed(false)),
        )
      ) {
        args.push("--ro-bind", directory, directory);
      }
    }

    args.push(
      "--bind",
      workspace,
      workspace,
      "--perms",
      "0111",
      "--tmpfs",
      home,
      "--ro-bind",
      bun,
      bun,
      "--ro-bind",
      bundle,
      bundle,
      "--remount-ro",
      home,
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--remount-ro",
      "/",
      "--chdir",
      workspace,
      "--",
      bun,
      "--smol",
      bundle,
    );

    return ["/usr/bin/bwrap", args];
  });
}
