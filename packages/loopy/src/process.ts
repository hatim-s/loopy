import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CommandOutput, ExecuteCommand, ResolvedCommand, RunOptions } from "./model.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const ENV_EXEC = "/usr/bin/env";

export class CommandExecutionError extends Error {
  readonly output: CommandOutput;
  readonly started: boolean;

  constructor(message: string, output: CommandOutput, started: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandExecutionError";
    this.output = output;
    this.started = started;
  }
}

function emptyOutput(): CommandOutput {
  return { stdout: "", stderr: "", exitCode: -1, durationMs: 0 };
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
  if (program.includes(sep)) {
    const candidate = resolve(cwd, program);
    if (await executable(candidate)) return realpath(candidate);
  } else {
    for (const directory of path.split(delimiter)) {
      const candidate = resolve(cwd, directory, program);
      if (await executable(candidate)) return realpath(candidate);
    }
  }
  throw new Error(`Executable not found: ${program}`);
}

async function packageDirectory(program: string, home: string): Promise<string | undefined> {
  if (!within(home, program)) return undefined;
  let directory = dirname(program);
  while (within(home, directory)) {
    if (directory === home) break;
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
  if (path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    throw new Error("Paths with control characters cannot be sandboxed");
  }
  return JSON.stringify(path);
}

function sandboxEnvironment(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).map(([name, value]) => {
    if (!name || name.includes("=") || name.includes("\0") || value?.includes("\0")) {
      throw new Error(`Invalid command environment variable: ${name}`);
    }
    return `${name}=${value ?? ""}`;
  });
}

async function macSandbox(
  program: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
): Promise<[string, string[]]> {
  if (!(await executable(SANDBOX_EXEC))) {
    throw new Error("Sandbox mode requires /usr/bin/sandbox-exec on macOS");
  }
  const home = await realpath(homedir());
  const allowedPackage = !within(workspace, program)
    ? await packageDirectory(program, home)
    : undefined;
  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    ...(!within(workspace, home) ? [`(deny file-read* (subpath ${sbpl(home)}))`] : []),
    `(allow file-read* (subpath ${sbpl(workspace)}))`,
    `(allow file-read* (literal ${sbpl(program)}))`,
    ...(allowedPackage ? [`(allow file-read* (subpath ${sbpl(allowedPackage)}))`] : []),
    `(allow file-write* (subpath ${sbpl(workspace)}))`,
    "(deny network*)",
  ].join("\n");
  return [SANDBOX_EXEC, ["-p", profile, ENV_EXEC, "-i", "--", ...sandboxEnvironment(env), program]];
}

async function linuxSandbox(
  program: string,
  workspace: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<[string, string[]]> {
  const bwrap = (await executable("/usr/bin/bwrap"))
    ? "/usr/bin/bwrap"
    : (await executable("/bin/bwrap"))
      ? "/bin/bwrap"
      : undefined;
  if (!bwrap) throw new Error("Sandbox mode requires bubblewrap on Linux");

  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--ro-bind", "/", "/"];
  const home = await realpath(homedir());
  if (home === "/") throw new Error("Sandbox mode requires a private home directory");
  args.push("--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev");
  try {
    if ((await stat("/run")).isDirectory()) args.push("--tmpfs", "/run");
  } catch {
    // Some Linux environments have no /run mount.
  }

  const createdDirectories = new Set<string>();
  const addDirectories = (base: string, target: string, includeTarget = false) => {
    if (!within(base, target)) return;
    let path = base;
    const parts = relative(base, target).split(sep).filter(Boolean);
    for (const part of includeTarget ? parts : parts.slice(0, -1)) {
      path = join(path, part);
      if (!createdDirectories.has(path)) {
        args.push("--dir", path);
        createdDirectories.add(path);
      }
    }
  };
  if (home !== "/tmp" && home !== "/run") {
    const maskedHomeParent = within("/tmp", home)
      ? "/tmp"
      : within("/run", home)
        ? "/run"
        : undefined;
    if (maskedHomeParent) addDirectories(maskedHomeParent, home, true);
    args.push("--tmpfs", home);
  }

  const programMount =
    !within(workspace, program) && within(home, program)
      ? ((await packageDirectory(program, home)) ?? program)
      : undefined;
  const maskedBase = (path: string) =>
    within(home, path)
      ? home
      : within("/tmp", path)
        ? "/tmp"
        : within("/run", path)
          ? "/run"
          : undefined;
  const sources: [string | undefined, boolean][] = [
    [workspace, true],
    [programMount, programMount ? (await stat(programMount)).isDirectory() : false],
  ];
  for (const [source, isDirectory] of sources) {
    if (!source) continue;
    const base = maskedBase(source);
    if (base) addDirectories(base, source, isDirectory);
  }
  if (programMount) args.push("--ro-bind", programMount, programMount);
  args.push("--bind", workspace, workspace);
  args.push("--chdir", cwd, "--", ENV_EXEC, "-i", "--", ...sandboxEnvironment(env), program);
  return [bwrap, args];
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error(`${name} must be a positive integer`);
  return limit;
}

async function commandContext(command: ResolvedCommand, options: RunOptions) {
  const workspace = await realpath(options.cwd);
  const cwd = await realpath(resolve(workspace, command.cwd ?? "."));
  if (options.mode === "sandbox" && !within(workspace, cwd)) {
    throw new Error(`Command directory is outside the sandbox workspace: ${command.cwd}`);
  }
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
  const program = await resolveProgram(command.program, cwd, env.PATH ?? "");
  if (options.mode === "full") return { cwd, env, program, args: command.args };
  if (options.mode !== "sandbox") throw new Error(`Unknown execution mode: ${options.mode}`);

  const [launcher, prefix] =
    process.platform === "darwin"
      ? await macSandbox(program, workspace, env)
      : process.platform === "linux"
        ? await linuxSandbox(program, workspace, cwd, env)
        : (() => {
            throw new Error(`Sandbox mode is unavailable on ${process.platform}`);
          })();
  return {
    cwd,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    program: launcher,
    args: [...prefix, ...command.args],
  };
}

export const executeCommand: ExecuteCommand = async (command, options) => {
  if (options.signal?.aborted)
    throw new CommandExecutionError("Command aborted", emptyOutput(), false, {
      cause: options.signal.reason,
    });
  const timeoutMs = positiveLimit(command.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxOutputBytes = positiveLimit(
    command.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
  );
  const { cwd, env, program, args } = await commandContext(command, options);
  if (options.signal?.aborted)
    throw new CommandExecutionError("Command aborted", emptyOutput(), false, {
      cause: options.signal.reason,
    });

  const started = performance.now();
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(program, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let settled = false;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        if (!child.killed) child.kill(signal);
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      if (!exited) {
        killTimer = setTimeout(() => kill("SIGKILL"), 250);
        killTimer.unref();
      }
    };
    const onAbort = () => stop(new Error("Command aborted", { cause: options.signal?.reason }));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () => stop(new Error(`Command timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    timeout.unref();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      if (!exited) kill("SIGKILL");
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", onAbort);
      const output: CommandOutput = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: exitCode ?? -1,
        durationMs: Math.round(performance.now() - started),
      };
      const reason =
        failure ?? error ?? (signal ? new Error(`Command terminated by ${signal}`) : undefined);
      if (reason) {
        return rejectOutput(
          new CommandExecutionError(reason.message, output, child.pid !== undefined, {
            cause: reason,
          }),
        );
      }
      resolveOutput(output);
    };

    const collect = (destination: Buffer[]) => (chunk: Buffer) => {
      const remaining = maxOutputBytes - bytes;
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        destination.push(captured);
        bytes += captured.length;
      }
      if (chunk.length > remaining) {
        stop(new Error(`Command output exceeded ${maxOutputBytes} bytes`));
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", () => {});
    child.once("exit", (code, signal) => {
      exited = true;
      kill("SIGKILL");
      if (killTimer) clearTimeout(killTimer);
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, 250);
      drainTimer.unref();
    });
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (code, signal) => finish(code, signal));
    child.stdin.end(command.stdin);
  });
};
