import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JsonValue, WorkflowDefinition } from "@loopy/contracts";
import type { VerificationContext, VerificationExecutor, VerificationResult } from "@loopy/runtime";

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
};

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[output truncated by Loopy]`;
}

async function runCommand(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<CommandResult> {
  const child = Bun.spawn(argv, {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer));
  return {
    argv,
    cwd,
    exitCode,
    stdout: truncate(stdout, maxOutputChars),
    stderr: truncate(stderr, maxOutputChars),
    timedOut,
  };
}

async function git(cwd: string, args: string[]): Promise<CommandResult> {
  const result = await runCommand(["git", "-C", cwd, ...args], cwd, 120_000, 32_000);
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  return result;
}

function commandCwd(root: string, configured?: string): string {
  const candidate = configured
    ? isAbsolute(configured)
      ? resolve(configured)
      : resolve(root, configured)
    : root;
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot))
    throw new Error(`Verification cwd escapes the run workspace: ${configured}`);
  return candidate;
}

export function createShellVerifier(options: {
  workingDirectory: string;
  maxOutputChars?: number;
}): VerificationExecutor {
  const root = resolve(options.workingDirectory);
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
        );
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
  const workingDirectory = workspace?.path ?? resolve(policy.workingDirectory ?? source);
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
        writableRoots: policy.writableRoots.map((root) => {
          const absolute = resolve(source, root);
          const withinProject = relative(source, absolute);
          return workspace &&
            withinProject !== ".." &&
            !withinProject.startsWith(`..${sep}`) &&
            !isAbsolute(withinProject)
            ? resolve(workingDirectory, withinProject)
            : absolute;
        }),
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
