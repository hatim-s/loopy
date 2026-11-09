import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Data, Effect } from "effect";
import { spawnCaptured } from "../../os";

export class DaemonInstallError extends Data.TaggedError("DaemonInstallError")<{
  message: string;
  cause?: unknown;
}> {}

const installIO = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new DaemonInstallError({ message: "Daemon service file operation failed.", cause }),
  });

export type DaemonExecResult = { code: number; stdout: string; stderr: string };

export type DaemonOperations = {
  makeDirectory: (path: string) => Effect.Effect<void, DaemonInstallError>;
  writeFile: (path: string, content: string) => Effect.Effect<void, DaemonInstallError>;
  removeFile: (path: string) => Effect.Effect<void, DaemonInstallError>;
  exec: (argv: string[]) => Effect.Effect<DaemonExecResult, DaemonInstallError>;
};

export const daemonOperations: DaemonOperations = {
  makeDirectory: (path) => installIO(() => mkdir(path, { recursive: true })),
  writeFile: (path, content) =>
    Effect.gen(function* () {
      yield* installIO(() => mkdir(dirname(path), { recursive: true }));
      yield* installIO(() => writeFile(path, content));
    }),
  removeFile: (path) => installIO(() => rm(path, { force: true })),
  exec: (argv) =>
    Effect.gen(function* () {
      const [program, ...args] = argv;

      if (!program) {
        return yield* Effect.fail(new DaemonInstallError({ message: "Service command is empty." }));
      }

      const result = yield* spawnCaptured(
        { program, args, cwd: process.cwd(), env: process.env },
        { timeoutMs: 30000, maxOutputBytes: 1024 * 1024 },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new DaemonInstallError({
              message:
                "Daemon service command failed. Inspect the service manager before retrying.",
              cause,
            }),
        ),
      );

      return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    }),
};

export function checkedExec(operations: DaemonOperations, argv: string[]) {
  return Effect.gen(function* () {
    const result = yield* operations.exec(argv);

    if (result.code !== 0) {
      return yield* Effect.fail(
        new DaemonInstallError({
          message: `${argv.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || result.code}. Check your user service manager and retry.`,
        }),
      );
    }

    return result;
  });
}
