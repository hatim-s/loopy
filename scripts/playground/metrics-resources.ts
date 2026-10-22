import { execFile } from "node:child_process";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { state } from "./config.js";

const manifestSchema = z.object({
  owner: z.number().int().positive(),
  children: z.array(z.object({ name: z.string(), pid: z.number().int().positive() })),
});

const execute = promisify(execFile);

export async function resources() {
  let processes: string | null = null;
  let disk: string | null = null;

  try {
    const manifest = manifestSchema.parse(await Bun.file(resolve(state, "processes.json")).json());
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

    processes = (
      await execute(
        "ps",
        ["-p", [...ids].join(","), "-o", "pid=,ppid=,%cpu=,rss=,vsz=,etime=,comm="],
        { timeout: 5000 },
      )
    ).stdout.trim();
    disk = (await execute("df", ["-k", state], { timeout: 5000 })).stdout.trim();
  } catch {
    // Missing process or disk context remains unknown rather than blocking API timing.
  }

  return {
    at: new Date().toISOString(),
    host: { cpus: cpus().length, freeBytes: freemem(), totalBytes: totalmem(), load: loadavg() },
    sampler: { memory: process.memoryUsage(), cpu: process.cpuUsage() },
    processes,
    disk,
    limits:
      "ps CPU is lifetime averaged; RSS is KiB; child discovery is bounded to three generations. Docker guest/container CPU is not measured.",
  };
}
