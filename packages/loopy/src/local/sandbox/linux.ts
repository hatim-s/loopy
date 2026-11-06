import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { Effect } from "effect";
import type { CommandExecutionError } from "../../core";
import { rejected, unstarted } from "../spawn";
import type { ProcessFilesystemError } from "./io";
import { absentPath, filesystem } from "./io";
import type { SandboxOptions } from "./launcher";
import { ENV_EXEC, envArgs, executable, packageDirectory, within } from "./paths";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"];

/** Growing bwrap argv plus the tmpfs mounts that hide the host's directories. */
type MountPlan = { args: string[]; tmpfs: string[]; created: Set<string> };

function findBwrap() {
  return Effect.gen(function* () {
    for (const candidate of BWRAP_CANDIDATES) {
      if (yield* executable(candidate)) {
        return candidate;
      }
    }

    return yield* Effect.fail(unstarted(new Error("Sandbox mode requires bubblewrap on Linux.")));
  });
}

function isDirectory(path: string) {
  return filesystem(() => stat(path)).pipe(
    Effect.map((value) => value.isDirectory()),
    Effect.catchIf(absentPath, () => Effect.succeed(false)),
  );
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

function programMountOf(program: string, workspace: string, home: string) {
  return Effect.gen(function* () {
    if (within(workspace, program) || !within(home, program)) {
      return undefined;
    }

    return (yield* packageDirectory(program, home)) ?? program;
  });
}

function bindProgram(
  plan: MountPlan,
  paths: { program: string; workspace: string; home: string; helper?: string },
) {
  return Effect.gen(function* () {
    const { program, workspace, home, helper } = paths;
    const { args } = plan;
    const programMount = yield* programMountOf(program, workspace, home);
    prepareUnderTmpfs(plan, workspace, true);

    if (programMount) {
      prepareUnderTmpfs(plan, programMount, yield* isDirectory(programMount));
      args.push("--ro-bind", programMount, programMount);
    }

    const helperCovered =
      !helper || within(workspace, helper) || Boolean(programMount && within(programMount, helper));

    if (helper && !helperCovered && prepareUnderTmpfs(plan, helper, false)) {
      args.push("--ro-bind", helper, helper);
    }
  });
}

/**
 * Read-only root, tmpfs over /tmp, /run and the home directory, then the
 * workspace (and the program's package, if it lives under home) bound back in.
 */
export function linuxSandbox({
  program,
  workspace,
  cwd,
  env,
  scratch,
  helper,
  protectedHome,
  mode,
}: SandboxOptions) {
  return Effect.gen(function* (): Effect.fn.Return<
    [string, string[]],
    CommandExecutionError | ProcessFilesystemError
  > {
    const environmentArgs = yield* Effect.try({ try: () => envArgs(env), catch: rejected });
    const bwrap = yield* findBwrap();

    if (mode === "full") {
      return [
        bwrap,
        [
          "--die-with-parent",
          "--unshare-all",
          "--share-net",
          "--bind",
          "/",
          "/",
          ...(protectedHome ? ["--tmpfs", protectedHome, "--remount-ro", protectedHome] : []),
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--chdir",
          cwd,
          "--",
          ENV_EXEC,
          "-i",
          "--",
          ...environmentArgs,
          helper ?? program,
        ],
      ];
    }

    const home = yield* filesystem(() => realpath(homedir()));

    if (home === "/") {
      return yield* Effect.fail(
        unstarted(new Error("Sandbox mode requires a private home directory.")),
      );
    }

    const args = ["--die-with-parent", "--new-session", "--unshare-all", "--ro-bind", "/", "/"];
    args.push("--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev");

    // Some Linux environments have no /run mount.
    if (yield* isDirectory("/run")) {
      args.push("--tmpfs", "/run");
    }

    const plan: MountPlan = { args, tmpfs: ["/tmp", "/run"], created: new Set() };
    hideHome(plan, home);

    yield* bindProgram(plan, { program, workspace, home, helper });
    prepareUnderTmpfs(plan, scratch, true);
    args.push("--bind", scratch, scratch, "--bind", workspace, workspace);

    if (protectedHome) {
      args.push("--tmpfs", protectedHome, "--remount-ro", protectedHome);
    }

    args.push("--chdir", cwd, "--", ENV_EXEC, "-i", "--", ...environmentArgs, helper ?? program);

    return [bwrap, args];
  });
}
