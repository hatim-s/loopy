import { execFile } from "node:child_process";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { decodeBoundary } from "@loopy/contract";
import { Schema } from "effect";
import { state } from "../config";
import { supervisorManifestSchema } from "../stack-identity";

const execute = promisify(execFile);

export const processRowSchema = Schema.Struct({
  pid: Schema.Int,
  ppid: Schema.Int,
  cpuPercent: Schema.Number,
  rssKiB: Schema.Number,
  elapsed: Schema.String,
  command: Schema.String,
});

type ProcessRow = typeof processRowSchema.Type;

// ps columns: pid, ppid, %cpu, rss, vsz, etime, comm. Rows that do not parse are dropped.
function processRows(text: string) {
  return text.split("\n").flatMap((line): ProcessRow[] => {
    const [pid, ppid, cpu, rss, , elapsed, ...command] = line.trim().split(/\s+/);

    const row = {
      pid: Number(pid),
      ppid: Number(ppid),
      cpuPercent: Number(cpu),
      rssKiB: Number(rss),
      command: command.join(" "),
    };

    const valid =
      Number.isInteger(row.pid) &&
      Number.isInteger(row.ppid) &&
      Number.isFinite(row.cpuPercent) &&
      Number.isFinite(row.rssKiB) &&
      row.command.length > 0;

    return valid && elapsed !== undefined ? [{ ...row, elapsed }] : [];
  });
}

export async function resources() {
  let processes: ProcessRow[] | null = null;
  let disk: string | null = null;

  try {
    const manifest = decodeBoundary(supervisorManifestSchema)(
      await Bun.file(resolve(state, "processes.json")).json(),
    );

    const ids = new Set([manifest.owner, ...manifest.children.map((child) => child.pid)]);
    let generation = [...ids];

    for (let depth = 0; depth < 3 && ids.size < 80; depth++) {
      const next: number[] = [];

      for (const pid of generation) {
        const result = await execute("pgrep", ["-P", String(pid)], { timeout: 2000 }).catch(
          () => null,
        );

        for (const value of result?.stdout.trim().split(/\s+/) ?? []) {
          const child = Number(value);

          if (Number.isSafeInteger(child) && child > 0 && !ids.has(child)) {
            ids.add(child);
            next.push(child);
          }
        }
      }

      generation = next;
    }

    processes = processRows(
      (
        await execute(
          "ps",
          ["-p", [...ids].join(","), "-o", "pid=,ppid=,%cpu=,rss=,vsz=,etime=,comm="],
          { timeout: 5000 },
        )
      ).stdout.trim(),
    );
    disk = (await execute("df", ["-k", state], { timeout: 5000 })).stdout.trim();
  } catch {
    // Missing process or disk context remains unknown rather than blocking API timing.
  }

  return {
    at: new Date().toISOString(),
    host: { cpus: cpus().length, freeBytes: freemem(), totalBytes: totalmem(), load: loadavg() },
    sampler: { memory: { ...process.memoryUsage() }, cpu: { ...process.cpuUsage() } },
    processes,
    disk,
    limits:
      "ps CPU is lifetime averaged; RSS is KiB; child discovery is bounded to three generations. Docker guest/container CPU is not measured.",
  };
}
