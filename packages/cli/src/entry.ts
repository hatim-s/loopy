import { resolve } from "node:path";

// Source runs from packages/cli/src; the package build emits this file to dist/cli/src.
const built = import.meta.path.endsWith(".js");

export const CLI_ENTRY = resolve(import.meta.dir, built ? "index.js" : "index.ts");

/** scripts/build.ts copies the dashboard build to dist/dashboard. */
export const DASHBOARD_ASSETS = resolve(
  import.meta.dir,
  built ? "../../dashboard" : "../../loopy/dist/dashboard",
);

export type DaemonFlags = {
  readonly home: string;
  readonly cwd?: string;
  readonly port: number;
  readonly concurrency?: number;
  readonly leaseMs?: number;
};

/** The argv that starts `loopy daemon run`; autostart and the installed service both use it. */
export function daemonCommand(flags: DaemonFlags): [string, string, ...string[]] {
  const command: [string, string, ...string[]] = [
    process.execPath,
    CLI_ENTRY,
    "--home",
    flags.home,
  ];

  if (flags.cwd !== undefined) {
    command.push("--cwd", flags.cwd);
  }

  command.push("daemon", "run", "--port", String(flags.port));

  if (flags.concurrency !== undefined) {
    command.push("--concurrency", String(flags.concurrency));
  }

  if (flags.leaseMs !== undefined) {
    command.push("--lease-ms", String(flags.leaseMs));
  }

  return command;
}
