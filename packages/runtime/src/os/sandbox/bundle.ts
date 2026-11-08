import { constants } from "node:fs";
import { copyFile, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParserInput } from "@loopy/core";
import { Effect } from "effect";
import type { CommandExecutionError } from "../command-error";
import { unstarted } from "../spawn";
import { macBundle } from "./bundle-darwin";
import { linuxBundle } from "./bundle-linux";
import { filesystem, removeScratch } from "./io";
import { sandboxTool } from "./tool";

/** `home` is a directory to hide even when the workspace contains it, or null for none. */
type Options = { bundle: string; workspace: string; network: boolean; home: string | null };

export type BundleSandboxOptions = Options & { bun: string };

export function withBundleSandbox(
  options: Options,
  execute: (launch: {
    program: string;
    args: string[];
  }) => Effect.Effect<ParserInput, CommandExecutionError>,
) {
  return Effect.acquireUseRelease(
    filesystem(() => mkdtemp(join(tmpdir(), "loopy-bundle-"))),
    (directory) =>
      Effect.exit(
        Effect.gen(function* () {
          const canonical = yield* filesystem(() => realpath(directory));
          const bundle = join(canonical, "bundle.js");
          // Bun enumerates bundle ancestors, so stage pinned bytes outside the daemon home.
          yield* filesystem(() => copyFile(options.bundle, bundle, constants.COPYFILE_EXCL));
          const [program, args] = yield* launcher({ ...options, bundle });

          return yield* execute({ program, args });
        }),
      ),
    removeScratch,
  ).pipe(Effect.flatMap((primary) => primary));
}

const launcher = Effect.fn(function* (options: Options) {
  const tool = yield* sandboxTool();
  const bun = yield* filesystem(() => realpath(process.execPath));

  if (tool.kind === "linux") {
    return yield* linuxBundle(tool.bwrap, { ...options, bun });
  }

  return yield* Effect.try({
    try: () => macBundle(tool.exec, { ...options, bun }),
    catch: unstarted,
  });
});
