import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandResult, ExecutionMode } from "../core/index.js";
import {
  CommandExecutionError,
  type ResolvedCommand,
  requirePositiveInteger,
} from "../core/index.js";
import { sandboxLauncher } from "./sandbox/launcher.js";
import { envArgs, resolveProgram, within } from "./sandbox/paths.js";
import type { Launch, Limits } from "./spawn.js";
import { emptyOutput, spawnCaptured, unstarted } from "./spawn.js";

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
 * Wraps the command in the platform sandbox. With private values the launcher
 * runs a Bun helper that reads them from stdin; `env -i` inside applies the rest.
 */
async function sandboxLaunch(command: ProcessCommand, context: SandboxContext): Promise<Launch> {
  const { program, workspace, cwd, scratch, env, sensitiveEnv } = context;
  const privateEnvironment = sensitiveEnv !== undefined && Object.keys(sensitiveEnv).length > 0;
  const helper = privateEnvironment ? await realpath(process.execPath) : undefined;

  if (privateEnvironment) {
    for (const key of Object.keys(sensitiveEnv)) {
      delete env[key];
    }
  }

  const [launcher, prefix] = await sandboxLauncher({
    program,
    workspace,
    cwd,
    env,
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
      env: sensitiveEnv,
      stdin: command.stdin,
    }),
  };
}

export async function prepareLaunch(
  command: ProcessCommand,
  options: LocalExecutionOptions,
): Promise<Launch & { scratch?: string }> {
  const workspace = await realpath(options.workspace);
  const cwd = await realpath(resolve(workspace, command.cwd ?? "."));

  if (options.mode === "sandbox" && !within(workspace, cwd)) {
    throw new Error(
      `Command directory '${command.cwd}' is outside the sandbox workspace. Choose a directory inside the workspace.`,
    );
  }

  if (!(await stat(cwd)).isDirectory()) {
    throw new Error(`Command directory '${cwd}' is not a directory. Choose an existing directory.`);
  }

  const env = launchEnvironment(command, options.mode);
  const effectiveEnv = { ...env, ...options.sensitiveEnv };
  // Validate without putting sensitive values into launcher arguments.
  envArgs(options.sensitiveEnv ?? {});
  const program = await resolveProgram(command.program, cwd, effectiveEnv.PATH ?? "");

  if (options.mode === "full" && !options.protectedHome) {
    return { cwd, env: effectiveEnv, program, args: command.args, stdin: command.stdin };
  }

  if (options.mode !== "sandbox" && options.mode !== "full") {
    throw new Error(`Execution mode '${options.mode}' is unknown. Choose full or sandbox.`);
  }

  return prepareSandbox(command, options, { program, workspace, cwd });
}

async function prepareSandbox(
  command: ProcessCommand,
  options: LocalExecutionOptions,
  paths: { program: string; workspace: string; cwd: string },
): Promise<Launch & { scratch: string }> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "loopy-run-")));

  try {
    const env = { ...launchEnvironment(command, options.mode), HOME: scratch, TMPDIR: scratch };

    const launch = await sandboxLaunch(command, {
      ...paths,
      env,
      scratch,
      sensitiveEnv: options.sensitiveEnv,
      protectedHome: options.protectedHome,
      mode: options.mode,
    });

    return { ...launch, scratch };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

export async function executeLocalCommand(
  command: ProcessCommand,
  options: LocalExecutionOptions,
): Promise<CommandResult> {
  const aborted = () =>
    new CommandExecutionError("Command aborted.", emptyOutput(), {
      cause: options.signal?.reason,
    });

  if (options.signal?.aborted) {
    throw aborted();
  }

  let launch: Awaited<ReturnType<typeof prepareLaunch>>;
  let limits: Limits;

  try {
    limits = commandLimits(command);
    launch = await prepareLaunch(command, options);
  } catch (error) {
    throw unstarted(error);
  }

  try {
    if (options.signal?.aborted) {
      throw aborted();
    }

    return await spawnCaptured(launch, limits, options.signal, performance.now());
  } finally {
    if (launch.scratch) {
      await rm(launch.scratch, { recursive: true, force: true });
    }
  }
}
