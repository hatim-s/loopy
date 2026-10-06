import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { constants, realpathSync, statSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CommandOutput, ExecutionMode, ResolvedCommand, RunOptions } from "../core/model.js";
import { CommandExecutionError, errorMessage } from "../runtime/errors.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 250;
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const ENV_EXEC = "/usr/bin/env";
const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"];

type Launch = {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
};
type LocalExecutionOptions = RunOptions & {
  signal?: AbortSignal;
  sensitiveEnv?: Record<string, string>;
};

// Runs inside the sandbox. Credentials arrive through stdin, never launcher argv.
const PRIVATE_ENV_LAUNCHER = `
const config = JSON.parse(await Bun.stdin.text());
const child = Bun.spawn([config.program, ...config.args], {
  env: { ...process.env, ...config.env },
  stdin: config.stdin === undefined ? "ignore" : new Blob([config.stdin]),
  stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
`;

const emptyOutput = (): CommandOutput => ({ stdout: "", stderr: "", exitCode: -1, durationMs: 0 });

/** An error raised before the process spawned, so retrying it is safe. */
function unstarted(error: unknown): CommandExecutionError {
  return new CommandExecutionError(errorMessage(error), emptyOutput(), false, { cause: error });
}

export function localRunOptions(cwd: string, mode: ExecutionMode): RunOptions {
  const path = realpathSync(cwd);
  if (!statSync(path).isDirectory()) throw new Error(`Workspace is not a directory: ${cwd}`);
  return { workspace: { kind: "local", path }, mode };
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function resolveProgram(program: string, cwd: string, path: string): Promise<string> {
  const candidates = program.includes(sep)
    ? [resolve(cwd, program)]
    : path.split(delimiter).map((directory) => resolve(cwd, directory, program));
  for (const candidate of candidates) if (await executable(candidate)) return realpath(candidate);
  throw new Error(`Executable not found: ${program}`);
}

/** The nearest package root above a program inside the home directory, if any. */
async function packageDirectory(program: string, home: string): Promise<string | undefined> {
  if (!within(home, program)) return undefined;
  for (let directory = dirname(program); within(home, directory) && directory !== home; ) {
    try {
      await access(join(directory, "package.json"));
      return directory;
    } catch {
      directory = dirname(directory);
    }
  }
  return undefined;
}

function sbpl(path: string): string {
  if (/[\0\n\r]/.test(path)) throw new Error("Paths with control characters cannot be sandboxed");
  return JSON.stringify(path);
}

function envArgs(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).map(([name, value]) => {
    if (!name || name.includes("=") || name.includes("\0") || value?.includes("\0"))
      throw new Error(`Invalid command environment variable: ${name}`);
    return `${name}=${value ?? ""}`;
  });
}

async function macSandbox(
  program: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  helper?: string,
): Promise<[string, string[]]> {
  if (!(await executable(SANDBOX_EXEC)))
    throw new Error("Sandbox mode requires /usr/bin/sandbox-exec on macOS");
  const home = await realpath(homedir());
  const allowedPackage = within(workspace, program)
    ? undefined
    : await packageDirectory(program, home);
  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    ...(within(workspace, home) ? [] : [`(deny file-read* (subpath ${sbpl(home)}))`]),
    `(allow file-read* (subpath ${sbpl(workspace)}))`,
    `(allow file-read* (literal ${sbpl(program)}))`,
    ...(helper ? [`(allow file-read* (literal ${sbpl(helper)}))`] : []),
    ...(allowedPackage ? [`(allow file-read* (subpath ${sbpl(allowedPackage)}))`] : []),
    `(allow file-write* (subpath ${sbpl(workspace)}))`,
    "(deny network*)",
  ].join("\n");
  return [SANDBOX_EXEC, ["-p", profile, ENV_EXEC, "-i", "--", ...envArgs(env), helper ?? program]];
}

/**
 * Read-only root, tmpfs over /tmp, /run and the home directory, then the
 * workspace (and the program's package, if it lives under home) bound back in.
 */
async function linuxSandbox(
  program: string,
  workspace: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  helper?: string,
): Promise<[string, string[]]> {
  let bwrap: string | undefined;
  for (const candidate of BWRAP_CANDIDATES) {
    if (await executable(candidate)) {
      bwrap = candidate;
      break;
    }
  }
  if (!bwrap) throw new Error("Sandbox mode requires bubblewrap on Linux");
  const home = await realpath(homedir());
  if (home === "/") throw new Error("Sandbox mode requires a private home directory");

  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--ro-bind", "/", "/"];
  args.push("--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev");
  try {
    if ((await stat("/run")).isDirectory()) args.push("--tmpfs", "/run");
  } catch {
    // Some Linux environments have no /run mount.
  }

  // Mount points under a tmpfs must be created inside it before binding.
  const masks = ["/tmp", "/run"];
  const created = new Set<string>();
  const mkdirs = (base: string, target: string, includeTarget: boolean) => {
    if (!within(base, target)) return;
    const parts = relative(base, target).split(sep).filter(Boolean);
    let path = base;
    for (const part of includeTarget ? parts : parts.slice(0, -1)) {
      path = join(path, part);
      if (created.has(path)) continue;
      args.push("--dir", path);
      created.add(path);
    }
  };
  const maskOf = (path: string) => [home, ...masks].find((mask) => within(mask, path));

  if (!masks.includes(home)) {
    const parent = masks.find((mask) => within(mask, home));
    if (parent) mkdirs(parent, home, true);
    args.push("--tmpfs", home);
  }
  const programMount =
    !within(workspace, program) && within(home, program)
      ? ((await packageDirectory(program, home)) ?? program)
      : undefined;
  const workspaceMask = maskOf(workspace);
  if (workspaceMask) mkdirs(workspaceMask, workspace, true);
  if (programMount) {
    const mask = maskOf(programMount);
    if (mask) mkdirs(mask, programMount, (await stat(programMount)).isDirectory());
    args.push("--ro-bind", programMount, programMount);
  }
  if (helper && !within(workspace, helper) && (!programMount || !within(programMount, helper))) {
    const mask = maskOf(helper);
    if (mask) {
      mkdirs(mask, helper, false);
      args.push("--ro-bind", helper, helper);
    }
  }
  args.push("--bind", workspace, workspace);
  args.push("--chdir", cwd, "--", ENV_EXEC, "-i", "--", ...envArgs(env), helper ?? program);
  return [bwrap, args];
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error(`${name} must be a positive integer`);
  return limit;
}

async function sandboxLauncher(
  program: string,
  workspace: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  helper?: string,
): Promise<[string, string[]]> {
  if (process.platform === "darwin") return macSandbox(program, workspace, env, helper);
  if (process.platform === "linux") return linuxSandbox(program, workspace, cwd, env, helper);
  throw new Error(`Sandbox mode is unavailable on ${process.platform}`);
}

async function prepareLaunch(
  command: ResolvedCommand,
  options: LocalExecutionOptions,
): Promise<Launch> {
  if (options.workspace.kind !== "local")
    throw new Error("Local command executor requires a local workspace");
  const workspace = await realpath(options.workspace.path);
  const cwd = await realpath(resolve(workspace, command.cwd ?? "."));
  if (options.mode === "sandbox" && !within(workspace, cwd))
    throw new Error(`Command directory is outside the sandbox workspace: ${command.cwd}`);
  if (!(await stat(cwd)).isDirectory())
    throw new Error(`Command directory is not a directory: ${cwd}`);

  const env: NodeJS.ProcessEnv =
    options.mode === "sandbox"
      ? {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: workspace,
          TMPDIR: workspace,
          LANG: process.env.LANG ?? "C.UTF-8",
          ...command.env,
        }
      : { ...process.env, ...command.env };
  const effectiveEnv = { ...env, ...options.sensitiveEnv };
  // Validate without putting sensitive values into launcher arguments.
  envArgs(options.sensitiveEnv ?? {});
  const program = await resolveProgram(command.program, cwd, effectiveEnv.PATH ?? "");
  if (options.mode === "full") return { cwd, env: effectiveEnv, program, args: command.args };
  if (options.mode !== "sandbox") throw new Error(`Unknown execution mode: ${options.mode}`);

  // The launcher itself runs with a minimal environment; `env -i` inside applies the real one.
  const privateEnvironment = options.sensitiveEnv && Object.keys(options.sensitiveEnv).length > 0;
  const helper = privateEnvironment ? await realpath(process.execPath) : undefined;
  if (privateEnvironment)
    for (const key of Object.keys(options.sensitiveEnv ?? {})) delete env[key];
  const [launcher, prefix] = await sandboxLauncher(program, workspace, cwd, env, helper);
  return {
    cwd,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    program: launcher,
    args: privateEnvironment
      ? [...prefix, "-e", PRIVATE_ENV_LAUNCHER]
      : [...prefix, ...command.args],
    ...(privateEnvironment
      ? {
          stdin: JSON.stringify({
            program,
            args: command.args,
            env: options.sensitiveEnv,
            stdin: command.stdin,
          }),
        }
      : {}),
  };
}

function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    if (!child.killed) child.kill(signal);
  }
}

/** Runs the process in its own group, bounds output and time, and captures both streams. */
function run(
  launch: Launch,
  command: ResolvedCommand,
  limits: { timeoutMs: number; maxOutputBytes: number },
  signal: AbortSignal | undefined,
  started: number,
): Promise<CommandOutput> {
  return new Promise((resolveOutput, rejectOutput) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.program, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      rejectOutput(unstarted(error));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let settled = false;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      killTree(child, "SIGTERM");
      if (!exited) {
        killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      }
    };
    const onAbort = () => stop(new Error("Command aborted", { cause: signal?.reason }));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () => stop(new Error(`Command timed out after ${limits.timeoutMs} ms`)),
      limits.timeoutMs,
    );
    timeout.unref();

    const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      if (!exited) killTree(child, "SIGKILL");
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      signal?.removeEventListener("abort", onAbort);
      // A byte limit or interruption may cut a UTF-8 code point. Leave it pending
      // rather than adding a replacement character that obscures a secret prefix.
      const text = (chunks: Buffer[]) => {
        const buffer = Buffer.concat(chunks);
        return failure || error || exitSignal
          ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(buffer, { stream: true })
          : buffer.toString("utf8");
      };
      const output: CommandOutput = {
        stdout: text(stdout),
        stderr: text(stderr),
        exitCode: exitCode ?? -1,
        durationMs: Math.round(performance.now() - started),
      };
      const reason =
        failure ??
        error ??
        (exitSignal ? new Error(`Command terminated by ${exitSignal}`) : undefined);
      if (reason) {
        rejectOutput(
          new CommandExecutionError(reason.message, output, child.pid !== undefined, {
            cause: reason,
          }),
        );
        return;
      }
      resolveOutput(output);
    };

    const collect = (destination: Buffer[]) => (chunk: Buffer) => {
      const remaining = limits.maxOutputBytes - bytes;
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        destination.push(captured);
        bytes += captured.length;
      }
      if (chunk.length > remaining)
        stop(new Error(`Command output exceeded ${limits.maxOutputBytes} bytes`));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", () => {});
    child.once("exit", (code, exitSignal) => {
      exited = true;
      // Kill the rest of the group; a grandchild holding the pipes must not keep us waiting.
      killTree(child, "SIGKILL");
      clearTimeout(killTimer);
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, exitSignal);
      }, KILL_GRACE_MS);
      drainTimer.unref();
    });
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (code, exitSignal) => finish(code, exitSignal));
    child.stdin.end(launch.stdin ?? command.stdin);
  });
}

export const executeLocalCommand = async (
  command: ResolvedCommand,
  options: LocalExecutionOptions,
): Promise<CommandOutput> => {
  const aborted = () =>
    new CommandExecutionError("Command aborted", emptyOutput(), false, {
      cause: options.signal?.reason,
    });
  if (options.signal?.aborted) throw aborted();
  let launch: Launch;
  let limits: { timeoutMs: number; maxOutputBytes: number };
  try {
    limits = {
      timeoutMs: positiveLimit(command.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs"),
      maxOutputBytes: positiveLimit(
        command.maxOutputBytes,
        DEFAULT_MAX_OUTPUT_BYTES,
        "maxOutputBytes",
      ),
    };
    launch = await prepareLaunch(command, options);
  } catch (error) {
    throw unstarted(error);
  }
  if (options.signal?.aborted) throw aborted();
  return run(launch, command, limits, options.signal, performance.now());
};
