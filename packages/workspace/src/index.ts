import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JsonValue, WorkflowDefinition } from "@loopy/contracts";
import type { VerificationContext, VerificationExecutor, VerificationResult } from "@loopy/runtime";

import { shellEnvironment } from "./shell";

export type GitWorkspaceCleanup = {
  removed: boolean;
  path: string;
  reason?: string;
};

export type GitWorkspace = {
  path: string;
  repositoryRoot: string;
  cleanup(): Promise<GitWorkspaceCleanup>;
};

export type PreparedWorkflowWorkspace = {
  definition: WorkflowDefinition;
  workingDirectory: string;
  verifier: VerificationExecutor;
  cleanup(): Promise<GitWorkspaceCleanup>;
};

type CommandResult = {
  argv: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

async function runCommand(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
  signal?: AbortSignal,
  env = shellEnvironment(),
): Promise<CommandResult> {
  signal?.throwIfAborted();
  const child = Bun.spawn(argv, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let timedOut = false;
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* Already reaped. */
      }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  // Discard excess output while draining both pipes under one retained byte budget.
  let remaining = maxOutputChars;
  let truncated = false;
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const take = Math.min(remaining, value.byteLength);
        truncated ||= take < value.byteLength;
        if (take) chunks.push(value.slice(0, take));
        remaining -= take;
      }
    } finally {
      reader.releaseLock();
    }
    return new TextDecoder().decode(Buffer.concat(chunks), { stream: true });
  };
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      read(child.stdout),
      read(child.stderr),
    ]);
    return { argv, cwd, exitCode, stdout, stderr, timedOut, truncated };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

async function git(cwd: string, args: string[]): Promise<CommandResult> {
  const result = await runCommand(["git", "-C", cwd, ...args], cwd, 120_000, 32_000, undefined, {
    ...shellEnvironment(),
    ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
  });
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  return result;
}

function commandCwd(root: string, configured?: string): string {
  const candidate = realpathSync(
    configured ? (isAbsolute(configured) ? resolve(configured) : resolve(root, configured)) : root,
  );
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot))
    throw new Error(`Verification cwd escapes the run workspace: ${configured}`);
  return candidate;
}

export function createShellVerifier(options: {
  workingDirectory: string;
  maxOutputChars?: number;
}): VerificationExecutor {
  const root = realpathSync(options.workingDirectory);
  const maxOutputChars = options.maxOutputChars ?? 64_000;
  return {
    async verify(context: VerificationContext): Promise<VerificationResult> {
      const source = context.node as unknown as Record<string, unknown>;
      const configured = Array.isArray(source.commands)
        ? source.commands
        : source.configuration && typeof source.configuration === "object"
          ? (source.configuration as Record<string, unknown>).commands
          : undefined;
      if (!Array.isArray(configured) || configured.length === 0)
        return { status: "failed", summary: "Verification node has no commands." };

      const results: CommandResult[] = [];
      for (const item of configured) {
        context.signal?.throwIfAborted();
        if (!item || typeof item !== "object")
          return { status: "failed", summary: "Verification command is malformed." };
        const command = item as Record<string, unknown>;
        if (typeof command.command !== "string" || !command.command.trim())
          return { status: "failed", summary: "Verification command is missing its executable." };
        const args = Array.isArray(command.args) ? command.args.map((value) => String(value)) : [];
        const result = await runCommand(
          [command.command, ...args],
          commandCwd(root, typeof command.cwd === "string" ? command.cwd : undefined),
          typeof command.timeoutMs === "number" ? command.timeoutMs : 120_000,
          maxOutputChars,
          context.signal,
        );
        context.signal?.throwIfAborted();
        results.push(result);
        if (result.timedOut || result.exitCode !== 0)
          return {
            status: "failed",
            summary: result.timedOut
              ? `${command.command} timed out.`
              : `${command.command} exited with code ${result.exitCode}.`,
            details: { commands: results as unknown as JsonValue },
          };
      }
      return {
        status: "passed",
        summary: `${results.length} verification command${results.length === 1 ? "" : "s"} passed.`,
        details: { commands: results as unknown as JsonValue },
      };
    },
  };
}

export async function createGitWorkspace(projectDir: string): Promise<GitWorkspace> {
  const requested = resolve(projectDir);
  const root = (await git(requested, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (!root) throw new Error(`${requested} is not a Git checkout.`);
  const path = mkdtempSync(join(tmpdir(), "loopy-workspace-"));
  try {
    await git(root, ["worktree", "add", "--detach", path, "HEAD"]);
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    repositoryRoot: root,
    async cleanup(): Promise<GitWorkspaceCleanup> {
      const status = (await git(path, ["status", "--porcelain"])).stdout.trim();
      if (status)
        return {
          removed: false,
          path,
          reason: "Run workspace contains uncommitted changes and was retained for inspection.",
        };
      await git(root, ["worktree", "remove", path]);
      return { removed: true, path };
    },
  };
}

export async function prepareWorkflowWorkspace(
  definition: WorkflowDefinition,
  projectDir: string,
): Promise<PreparedWorkflowWorkspace> {
  const source = resolve(projectDir);
  const policy = definition.policies.workspace;
  const workspace = policy.useGitWorktree ? await createGitWorkspace(source) : undefined;
  const rebaseIntoWorkspace = (absolute: string): string => {
    if (!workspace) return absolute;
    const withinRepository = relative(workspace.repositoryRoot, absolute);
    return withinRepository !== ".." &&
      !withinRepository.startsWith(`..${sep}`) &&
      !isAbsolute(withinRepository)
      ? resolve(workspace.path, withinRepository)
      : absolute;
  };
  const workingDirectory = rebaseIntoWorkspace(resolve(source, policy.workingDirectory ?? "."));
  if (!workspace && !policy.allowDirtyWorkspace) {
    const status = (await git(workingDirectory, ["status", "--porcelain"])).stdout.trim();
    if (status)
      throw new Error(
        `Workspace ${workingDirectory} has uncommitted changes; enable Git worktree isolation or explicitly allow a dirty workspace.`,
      );
  }
  const prepared: WorkflowDefinition = {
    ...definition,
    policies: {
      ...definition.policies,
      workspace: {
        ...policy,
        workingDirectory,
        writableRoots: policy.writableRoots.map((root) =>
          rebaseIntoWorkspace(resolve(source, root)),
        ),
      },
    },
  };
  return {
    definition: prepared,
    workingDirectory,
    verifier: createShellVerifier({ workingDirectory }),
    cleanup: workspace
      ? () => workspace.cleanup()
      : async () => ({ removed: false, path: workingDirectory, reason: "Using project checkout." }),
  };
}

export { createShellExecutor, shellEnvironment } from "./shell";
