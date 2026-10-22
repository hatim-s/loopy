import { join } from "node:path";
import { z } from "zod";
import { type RunView, runStatusSchema } from "../../packages/loopy/src/contract/index.ts";
import { readDaemonFile } from "../../packages/loopy/src/local/index.ts";
import { environment, home, state } from "./config.ts";

const rows = z.array(z.strictObject({ id: z.string(), status: runStatusSchema }));

const sidecars = z.array(z.strictObject({ suffix: z.string(), bytes: z.number().nonnegative() }));

const backupSchema = z.strictObject({
  method: z.string(),
  source: z.string(),
  destination: z.string(),
  destinationJournal: z.literal("delete"),
  sidecarsBefore: sidecars,
  sidecarsAfter: sidecars,
  sourceRows: rows,
  copiedRows: rows,
  integrity: z.string(),
  matchesSource: z.boolean(),
  matchesApi: z.boolean().nullable(),
  matches45ApiRuns: z.boolean(),
});

export async function backupClosedDatabase(
  apiRuns: Pick<RunView, "id" | "status">[] | null,
  destination = join(state, "daemon-readonly.sqlite"),
) {
  if (readDaemonFile(home)) {
    throw new Error("Refusing a diagnostic backup while the isolated daemon is alive.");
  }

  const child = Bun.spawn(["python3", join(import.meta.dir, "backup.py")], {
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

  return backupSchema.parse(JSON.parse(stdout));
}
