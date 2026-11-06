import { join } from "node:path";
import { decodeBoundary, type RunView } from "@loopy/contract";
import { readDaemonFile } from "@loopy/runtime/local";
import { backupSchema } from "./backup-schema";
import { environment, home, state } from "./config";

export async function backupClosedDatabase(
  apiRuns: Pick<RunView, "id" | "status">[] | null,
  destination = join(state, "daemon-readonly.sqlite"),
) {
  if (readDaemonFile(home)) {
    throw new Error("Refusing a diagnostic backup while the isolated daemon is alive.");
  }

  const child = Bun.spawn(["python3", join(import.meta.dir, "./backup.py")], {
    env: environment(),
    stdin: new Blob([JSON.stringify({ source: join(home, "runs.sqlite"), destination, apiRuns })]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timeout));

  if (exitCode !== 0) {
    throw new Error(`Closed diagnostic backup failed: ${stderr.trim()}`);
  }

  return decodeBoundary(backupSchema)(JSON.parse(stdout));
}
