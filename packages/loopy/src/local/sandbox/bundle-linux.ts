import { stat } from "node:fs/promises";
import { Effect } from "effect";
import type { CommandExecutionError } from "../../core/index.js";
import type { BundleSandboxOptions } from "./bundle.js";
import type { ProcessFilesystemError } from "./io.js";
import { absentPath, filesystem } from "./io.js";

export function linuxBundle({ bundle, workspace, bun, network, home }: BundleSandboxOptions) {
  return Effect.gen(function* (): Effect.fn.Return<
    [string, string[]],
    CommandExecutionError | ProcessFilesystemError
  > {
    const args = ["--die-with-parent", "--unshare-all"];

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
