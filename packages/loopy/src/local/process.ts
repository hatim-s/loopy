import { realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { CommandOutput, ExecutionMode, ResolvedCommand, RunOptions } from "../core/index.js";
import { requirePositiveInteger } from "../core/index.js";
import { CommandExecutionError } from "../runtime/index.js";
import { sandboxLauncher } from "./sandbox/launcher.js";
import { envArgs, resolveProgram, within } from "./sandbox/paths.js";
import type { Launch, Limits } from "./spawn.js";
import { emptyOutput, spawnCaptured, unstarted } from "./spawn.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type LocalExecutionOptions = RunOptions & {
  signal?: AbortSignal;
  sensitiveEnv?: Record<string, string>;
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

export function localRunOptions(cwd: string, mode: ExecutionMode): RunOptions {
  const path = realpathSync(cwd);

  if (!statSync(path).isDirectory()) {
    throw new Error(`Workspace '${cwd}' is not a directory.`);
  }

  return { workspace: { kind: "local", path }, mode };
}

function commandLimits(command: ResolvedCommand): Limits {
  return {
    timeoutMs: requirePositiveInteger(command.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs"),
    maxOutputBytes: requirePositiveInteger(
      command.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    ),
  };
}

function launchEnvironment(
  command: ResolvedCommand,
  mode: ExecutionMode,
  workspace: string,
): NodeJS.ProcessEnv {
  if (mode === "full") {
    return { ...process.env, ...command.env };
  }

  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: workspace,
    TMPDIR: workspace,
    LANG: process.env.LANG ?? "C.UTF-8",
    ...command.env,
  };
}

/**
 * Wraps the command in the platform sandbox. With private values the launcher
 * runs a Bun helper that reads them from stdin; `env -i` inside applies the rest.
 */
async function sandboxLaunch(
  command: ResolvedCommand,
  program: string,
  workspace: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  sensitiveEnv: Record<string, string> | undefined,
): Promise<Launch> {
  const privateEnvironment = sensitiveEnv !== undefined && Object.keys(sensitiveEnv).length > 0;
  const helper = privateEnvironment ? await realpath(process.execPath) : undefined;

  if (privateEnvironment) {
    for (const key of Object.keys(sensitiveEnv)) {
      delete env[key];
    }
  }

  const [launcher, prefix] = await sandboxLauncher(program, workspace, cwd, env, helper);

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
  command: ResolvedCommand,
  options: LocalExecutionOptions,
): Promise<Launch> {
  if (options.workspace.kind !== "local") {
    throw new Error("The local command executor requires a local workspace.");
  }

  const workspace = await realpath(options.workspace.path);
  const cwd = await realpath(resolve(workspace, command.cwd ?? "."));

  if (options.mode === "sandbox" && !within(workspace, cwd)) {
    throw new Error(`Command directory '${command.cwd}' is outside the sandbox workspace.`);
  }

  if (!(await stat(cwd)).isDirectory()) {
    throw new Error(`Command directory '${cwd}' is not a directory.`);
  }

  const env = launchEnvironment(command, options.mode, workspace);
  const effectiveEnv = { ...env, ...options.sensitiveEnv };
  // Validate without putting sensitive values into launcher arguments.
  envArgs(options.sensitiveEnv ?? {});
  const program = await resolveProgram(command.program, cwd, effectiveEnv.PATH ?? "");

  if (options.mode === "full") {
    return { cwd, env: effectiveEnv, program, args: command.args, stdin: command.stdin };
  }

  if (options.mode !== "sandbox") {
    throw new Error(`Execution mode '${options.mode}' is unknown.`);
  }

  return sandboxLaunch(command, program, workspace, cwd, env, options.sensitiveEnv);
}

export async function executeLocalCommand(
  command: ResolvedCommand,
  options: LocalExecutionOptions,
): Promise<CommandOutput> {
  const aborted = () =>
    new CommandExecutionError("Command aborted.", emptyOutput(), false, {
      cause: options.signal?.reason,
    });

  if (options.signal?.aborted) {
    throw aborted();
  }

  let launch: Launch;
  let limits: Limits;

  try {
    limits = commandLimits(command);
    launch = await prepareLaunch(command, options);
  } catch (error) {
    throw unstarted(error);
  }

  if (options.signal?.aborted) {
    throw aborted();
  }

  return spawnCaptured(launch, limits, options.signal, performance.now());
}
