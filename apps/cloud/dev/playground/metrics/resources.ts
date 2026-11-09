import { execFile } from "node:child_process";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { decodeBoundary } from "@loopy/contract";
import { Schema } from "effect";
import { processTree } from "../../stack/processes";
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

// A failed ps or df leaves that context unknown rather than blocking API timing.
async function tool(file: string, args: string[]) {
  try {
    return (await execute(file, args, { timeout: 5000 })).stdout.trim();
  } catch {
    return null;
  }
}

async function supervisedProcesses() {
  const file = Bun.file(resolve(state, "processes.json"));

  if (!(await file.exists())) {
    return null;
  }

  const manifest = decodeBoundary(supervisorManifestSchema)(await file.json());
  const roots = [manifest.owner, ...manifest.children.map((child) => child.pid)];
  const ids = await processTree(roots).catch(() => null);

  if (!ids) {
    return null;
  }

  const table = await tool("ps", [
    "-p",
    [...ids].join(","),
    "-o",
    "pid=,ppid=,%cpu=,rss=,vsz=,etime=,comm=",
  ]);

  return table === null ? null : processRows(table);
}

export async function resources() {
  const processes = await supervisedProcesses();
  const disk = await tool("df", ["-k", state]);

  return {
    at: new Date().toISOString(),
    host: { cpus: cpus().length, freeBytes: freemem(), totalBytes: totalmem(), load: loadavg() },
    sampler: { memory: { ...process.memoryUsage() }, cpu: { ...process.cpuUsage() } },
    processes,
    disk,
    limits:
      "ps CPU is lifetime averaged; RSS is KiB; children come from one process table snapshot. Docker guest/container CPU is not measured.",
  };
}
