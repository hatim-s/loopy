import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { ENV_EXEC, envArgs, executable, packageDirectory, within } from "./paths.js";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"];

/** Growing bwrap argv plus the tmpfs mounts that hide the host's directories. */
type MountPlan = { args: string[]; tmpfs: string[]; created: Set<string> };

async function findBwrap(): Promise<string> {
  for (const candidate of BWRAP_CANDIDATES) {
    if (await executable(candidate)) {
      return candidate;
    }
  }

  throw new Error("Sandbox mode requires bubblewrap on Linux.");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function tmpfsOver(plan: MountPlan, path: string): string | undefined {
  return plan.tmpfs.find((mask) => within(mask, path));
}

/** Mount points under a tmpfs must be created inside it before binding. */
function planDirectories(plan: MountPlan, base: string, target: string, includeTarget: boolean) {
  const parts = relative(base, target).split(sep).filter(Boolean);
  let path = base;

  for (const part of includeTarget ? parts : parts.slice(0, -1)) {
    path = join(path, part);

    if (plan.created.has(path)) {
      continue;
    }

    plan.args.push("--dir", path);
    plan.created.add(path);
  }
}

/** Creates the directories for `target` when a tmpfs hides it. True when one does. */
function prepareUnderTmpfs(plan: MountPlan, target: string, includeTarget: boolean): boolean {
  const mask = tmpfsOver(plan, target);

  if (!mask) {
    return false;
  }

  planDirectories(plan, mask, target, includeTarget);

  return true;
}

function hideHome(plan: MountPlan, home: string): void {
  if (plan.tmpfs.includes(home)) {
    return;
  }

  prepareUnderTmpfs(plan, home, true);
  plan.args.push("--tmpfs", home);
  // Home goes first so a workspace under it is created relative to the home tmpfs.
  plan.tmpfs.unshift(home);
}

async function programMountOf(
  program: string,
  workspace: string,
  home: string,
): Promise<string | undefined> {
  if (within(workspace, program) || !within(home, program)) {
    return undefined;
  }

  return (await packageDirectory(program, home)) ?? program;
}

/**
 * Read-only root, tmpfs over /tmp, /run and the home directory, then the
 * workspace (and the program's package, if it lives under home) bound back in.
 */
export async function linuxSandbox(
  program: string,
  workspace: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  helper?: string,
): Promise<[string, string[]]> {
  const bwrap = await findBwrap();
  const home = await realpath(homedir());

  if (home === "/") {
    throw new Error("Sandbox mode requires a private home directory.");
  }

  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--ro-bind", "/", "/"];
  args.push("--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev");

  // Some Linux environments have no /run mount.
  if (await isDirectory("/run")) {
    args.push("--tmpfs", "/run");
  }

  const plan: MountPlan = { args, tmpfs: ["/tmp", "/run"], created: new Set() };
  hideHome(plan, home);

  const programMount = await programMountOf(program, workspace, home);
  prepareUnderTmpfs(plan, workspace, true);

  if (programMount) {
    prepareUnderTmpfs(plan, programMount, await isDirectory(programMount));
    args.push("--ro-bind", programMount, programMount);
  }

  const helperCovered =
    !helper || within(workspace, helper) || Boolean(programMount && within(programMount, helper));

  if (helper && !helperCovered && prepareUnderTmpfs(plan, helper, false)) {
    args.push("--ro-bind", helper, helper);
  }

  args.push("--bind", workspace, workspace);
  args.push("--chdir", cwd, "--", ENV_EXEC, "-i", "--", ...envArgs(env), helper ?? program);

  return [bwrap, args];
}
