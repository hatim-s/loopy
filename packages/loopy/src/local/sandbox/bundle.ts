import { constants } from "node:fs";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Data, Effect, Exit } from "effect";
import type { CommandExecutionError } from "../../core/index.js";
import { type CommandResult } from "../../core/index.js";
import { unstarted } from "../spawn.js";
import { macBundle } from "./bundle-darwin.js";
import { linuxBundle } from "./bundle-linux.js";
import type { ProcessFilesystemError } from "./io.js";
import { filesystem } from "./io.js";
import { executable } from "./paths.js";

type Options = { bundle: string; workspace: string; network: boolean; home: string };

export type BundleSandboxOptions = Options & { bun: string };

export class BundleCleanupError extends Data.TaggedError("BundleCleanupError")<{
  cause: ProcessFilesystemError;
  primary: Exit.Exit<CommandResult, CommandExecutionError | ProcessFilesystemError>;
}> {}

export function withBundleSandbox(
  options: Options,
  execute: (launch: {
    program: string;
    args: string[];
  }) => Effect.Effect<CommandResult, CommandExecutionError>,
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
    (directory, primary) =>
      filesystem(() => rm(directory, { recursive: true, force: true })).pipe(
        Effect.mapError(
          (cause) =>
            new BundleCleanupError({
              cause,
              primary: Exit.isSuccess(primary) ? primary.value : Exit.failCause(primary.cause),
            }),
        ),
      ),
  ).pipe(Effect.flatMap((primary) => primary));
}

const launcher = Effect.fn(function* (options: Options) {
  const bun = yield* filesystem(() => realpath(process.execPath));

  if (process.platform === "darwin" && (yield* executable("/usr/bin/sandbox-exec"))) {
    return macBundle({ ...options, bun });
  }

  if (process.platform === "linux" && (yield* executable("/usr/bin/bwrap"))) {
    return yield* linuxBundle({ ...options, bun });
  }

  return yield* Effect.fail(
    unstarted(new Error("Bundle execution requires sandbox-exec on macOS or bubblewrap on Linux.")),
  );
});
