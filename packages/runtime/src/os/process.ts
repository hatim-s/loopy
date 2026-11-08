import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecutionMode } from "@loopy/core";
import { errnoCode } from "@loopy/core";
import { Effect, Exit } from "effect";
import type { ResolvedCommand } from "./command-error";
import { filesystem, removeScratch } from "./sandbox/io";
import { sandboxLauncher } from "./sandbox/launcher";
import { envArgs, resolveProgram, within } from "./sandbox/paths";
import type { Launch } from "./spawn";
import { aborted, rejected, spawnCaptured } from "./spawn";

export type LocalExecutionOptions = {
  workspace: string;
  mode: ExecutionMode;
  signal?: AbortSignal;
  sensitiveEnv: Record<string, string>;
  protectedHome: string;
};

type SandboxPaths = { program: string; workspace: string; cwd: string };

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

function launchEnvironment(command: ResolvedCommand, mode: ExecutionMode): NodeJS.ProcessEnv {
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
function sandboxLaunch(
  command: ResolvedCommand,
  options: LocalExecutionOptions,
  context: SandboxPaths & { scratch: string; env: NodeJS.ProcessEnv; protectedHome: string },
) {
  return Effect.gen(function* () {
    const { program, cwd, env } = context;
    const stdin = command.stdin ?? undefined;

    const privateEnvironment =
      options.mode === "full" || Object.keys(options.sensitiveEnv).length > 0;

    const helper = privateEnvironment
      ? yield* filesystem(() => realpath(process.execPath))
      : undefined;

    const [launcher, prefix] = yield* sandboxLauncher({
      ...context,
      env: privateEnvironment ? { PATH: env.PATH, LANG: env.LANG } : env,
      helper,
      mode: options.mode,
    });

    const launch: Launch = {
      cwd,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      program: launcher,
      args: [],
    };

    if (!privateEnvironment) {
      return { ...launch, args: [...prefix, ...command.args], stdin };
    }

    return {
      ...launch,
      args: [...prefix, "-e", PRIVATE_ENV_LAUNCHER],
      stdin: JSON.stringify({
        program,
        args: command.args,
        env: { ...env, ...options.sensitiveEnv },
        stdin,
      }),
    };
  });
}

export function prepareLaunch(command: ResolvedCommand, options: LocalExecutionOptions) {
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

    return yield* prepareSandbox(command, options, { program, workspace, cwd }, env);
  });
}

function prepareSandbox(
  command: ResolvedCommand,
  options: LocalExecutionOptions,
  paths: SandboxPaths,
  env: NodeJS.ProcessEnv,
) {
  return Effect.acquireUseRelease(
    filesystem(() => mkdtemp(join(tmpdir(), "loopy-run-"))),
    (directory) =>
      Effect.gen(function* () {
        const scratch = yield* filesystem(() => realpath(directory));
        const protectedHome = yield* filesystem(() => realpath(options.protectedHome));

        const sandboxEnv =
          options.mode === "sandbox" ? { ...env, HOME: scratch, TMPDIR: scratch } : env;

        const launch = yield* sandboxLaunch(command, options, {
          ...paths,
          env: sandboxEnv,
          scratch,
          protectedHome,
        });

        return { ...launch, scratch };
      }),
    (directory, primary) =>
      Exit.isSuccess(primary)
        ? Effect.void
        : filesystem(() => rm(directory, { recursive: true, force: true })),
  );
}

export function executeLocalCommand(command: ResolvedCommand, options: LocalExecutionOptions) {
  return Effect.gen(function* () {
    if (options.signal?.aborted) {
      return yield* Effect.fail(aborted(options.signal));
    }

    return yield* Effect.acquireUseRelease(
      prepareLaunch(command, options),
      (launch) =>
        Effect.exit(
          options.signal?.aborted
            ? Effect.fail(aborted(options.signal))
            : spawnCaptured(launch, {
                timeoutMs: command.timeoutMs,
                maxOutputBytes: command.maxOutputBytes,
                signal: options.signal,
              }),
        ),
      (launch, primary) => removeScratch(launch.scratch, primary),
    ).pipe(Effect.flatMap((primary) => primary));
  });
}
