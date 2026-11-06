import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandResult, ExecutionMode } from "@loopy/core";
import {
  CommandExecutionError,
  errnoCode,
  type ResolvedCommand,
  requirePositiveInteger,
} from "@loopy/core";
import { Data, Effect, Exit } from "effect";
import type { ProcessFilesystemError } from "./sandbox/io";
import { filesystem } from "./sandbox/io";
import { sandboxLauncher } from "./sandbox/launcher";
import { envArgs, resolveProgram, within } from "./sandbox/paths";
import type { Launch, Limits } from "./spawn";
import { emptyOutput, rejected, spawnCaptured, unstarted } from "./spawn";

type ProcessCommand = ResolvedCommand & { maxOutputBytes?: number };

type SandboxContext = {
  program: string;
  workspace: string;
  cwd: string;
  scratch: string;
  env: NodeJS.ProcessEnv;
  sensitiveEnv?: Record<string, string>;
  protectedHome?: string;
  mode: ExecutionMode;
};

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type LocalExecutionOptions = {
  workspace: string;
  mode: ExecutionMode;
  signal?: AbortSignal;
  sensitiveEnv?: Record<string, string>;
  protectedHome?: string;
};

// Runs inside the sandbox. Credentials arrive through stdin, never launcher argv.
export const PRIVATE_ENV_LAUNCHER = `
const config = JSON.parse(await Bun.stdin.text());
const child = Bun.spawn([config.program, ...config.args], {
  env: { ...process.env, ...config.env },
  stdin: config.stdin === undefined ? "ignore" : new Blob([config.stdin]),
  stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
`;

function commandLimits(command: ProcessCommand): Limits {
  return {
    timeoutMs: requirePositiveInteger(command.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs"),
    maxOutputBytes: requirePositiveInteger(
      command.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    ),
  };
}

function launchEnvironment(command: ProcessCommand, mode: ExecutionMode): NodeJS.ProcessEnv {
  if (mode === "full") {
    return { ...process.env, ...command.env };
  }

  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...command.env,
  };
}

/**
 * Full environments can contain ambient credentials, so they travel through
 * stdin with declared secrets instead of appearing in the sandbox launch argv.
 */
function sandboxLaunch(command: ProcessCommand, context: SandboxContext) {
  return Effect.gen(function* () {
    const { program, workspace, cwd, scratch, env, sensitiveEnv } = context;

    const privateEnvironment =
      context.mode === "full" ||
      (sensitiveEnv !== undefined && Object.keys(sensitiveEnv).length > 0);

    const helper = privateEnvironment
      ? yield* filesystem(() => realpath(process.execPath))
      : undefined;

    const childEnv = { ...env, ...sensitiveEnv };
    const launcherEnv = privateEnvironment ? { PATH: env.PATH, LANG: env.LANG } : env;

    const [launcher, prefix] = yield* sandboxLauncher({
      program,
      workspace,
      cwd,
      env: launcherEnv,
      scratch,
      helper,
      protectedHome: context.protectedHome,
      mode: context.mode,
    });

    const launch: Launch = {
      cwd,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      program: launcher,
      args: [],
    };

    if (!privateEnvironment) {
      return { ...launch, args: [...prefix, ...command.args], stdin: command.stdin };
    }

    return {
      ...launch,
      args: [...prefix, "-e", PRIVATE_ENV_LAUNCHER],
      stdin: JSON.stringify({
        program,
        args: command.args,
        env: childEnv,
        stdin: command.stdin,
      }),
    };
  });
}

export function prepareLaunch(command: ProcessCommand, options: LocalExecutionOptions) {
  return Effect.gen(function* () {
    const workspace = yield* filesystem(() => realpath(options.workspace));

    const cwd = yield* filesystem(() => realpath(resolve(workspace, command.cwd ?? "."))).pipe(
      Effect.catchIf(
        (error) => ["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(errnoCode(error.cause) ?? ""),
        (error) => Effect.fail(rejected(error.cause)),
      ),
    );

    if (options.mode === "sandbox" && !within(workspace, cwd)) {
      return yield* Effect.fail(
        rejected(
          new Error(
            `Command directory '${command.cwd}' is outside the sandbox workspace. Choose a directory inside the workspace.`,
          ),
        ),
      );
    }

    if (!(yield* filesystem(() => stat(cwd))).isDirectory()) {
      return yield* Effect.fail(
        rejected(
          new Error(`Command directory '${cwd}' is not a directory. Choose an existing directory.`),
        ),
      );
    }

    const env = launchEnvironment(command, options.mode);
    const effectiveEnv = { ...env, ...options.sensitiveEnv };
    // Validate without putting sensitive values into launcher arguments.
    yield* Effect.try({ try: () => envArgs(effectiveEnv), catch: rejected });
    const program = yield* resolveProgram(command.program, cwd, effectiveEnv.PATH ?? "");

    if (options.mode === "full" && !options.protectedHome) {
      return { cwd, env: effectiveEnv, program, args: command.args, stdin: command.stdin };
    }

    if (options.mode !== "sandbox" && options.mode !== "full") {
      return yield* Effect.fail(
        unstarted(
          new Error(`Execution mode '${options.mode}' is unknown. Choose full or sandbox.`),
        ),
      );
    }

    return yield* prepareSandbox(command, options, { program, workspace, cwd });
  });
}

function prepareSandbox(
  command: ProcessCommand,
  options: LocalExecutionOptions,
  paths: { program: string; workspace: string; cwd: string },
) {
  return Effect.acquireUseRelease(
    filesystem(() => mkdtemp(join(tmpdir(), "loopy-run-"))),
    (directory) =>
      Effect.gen(function* () {
        const scratch = yield* filesystem(() => realpath(directory));
        const env = launchEnvironment(command, options.mode);

        if (options.mode === "sandbox") {
          env.HOME = scratch;
          env.TMPDIR = scratch;
        }

        const protectedHome = options.protectedHome;

        const launch = yield* sandboxLaunch(command, {
          ...paths,
          env,
          scratch,
          sensitiveEnv: options.sensitiveEnv,
          protectedHome:
            protectedHome === undefined
              ? undefined
              : yield* filesystem(() => realpath(protectedHome)),
          mode: options.mode,
        });

        return { ...launch, scratch };
      }),
    (directory, primary) =>
      Exit.isSuccess(primary)
        ? Effect.void
        : filesystem(() => rm(directory, { recursive: true, force: true })),
  );
}

export function executeLocalCommand(command: ProcessCommand, options: LocalExecutionOptions) {
  return Effect.gen(function* () {
    const aborted = () =>
      new CommandExecutionError({
        message: "Command aborted.",
        output: emptyOutput(),
        cause: options.signal?.reason,
        reason: "aborted",
      });

    if (options.signal?.aborted) {
      return yield* Effect.fail(aborted());
    }

    const limits = yield* Effect.try({ try: () => commandLimits(command), catch: rejected });

    return yield* Effect.acquireUseRelease(
      prepareLaunch(command, options),
      (launch) =>
        Effect.exit(
          options.signal?.aborted
            ? Effect.fail(aborted())
            : spawnCaptured(launch, limits, options.signal, performance.now()),
        ),
      (launch, primary) =>
        "scratch" in launch
          ? filesystem(() => rm(launch.scratch, { recursive: true, force: true })).pipe(
              Effect.mapError(
                (cause) =>
                  new ProcessCleanupError({
                    cause,
                    primary: Exit.isSuccess(primary)
                      ? primary.value
                      : Exit.failCause(primary.cause),
                  }),
              ),
            )
          : Effect.void,
    ).pipe(Effect.flatMap((primary) => primary));
  });
}

/** Retains the process outcome if scratch removal fails after termination. */
export class ProcessCleanupError extends Data.TaggedError("ProcessCleanupError")<{
  cause: ProcessFilesystemError;
  primary: Exit.Exit<CommandResult, CommandExecutionError | ProcessFilesystemError>;
}> {}
