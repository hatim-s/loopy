import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errnoCode, writeFileAtomically } from "./fs.js";

const daemonFileSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int(),
  token: z.string(),
  startedAt: z.string(),
});

type DaemonFile = z.infer<typeof daemonFileSchema>;

export function readDaemonFile(home: string): DaemonFile | undefined {
  const file = join(home, "daemon.json");

  if (!existsSync(file)) {
    return undefined;
  }

  const record = daemonFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));

  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (errnoCode(error) === "ESRCH") {
      return undefined;
    }

    throw error;
  }

  return record;
}

export function writeDaemonFile(home: string, record: DaemonFile): void {
  writeFileAtomically(join(home, "daemon.json"), `${JSON.stringify(record)}\n`, 0o600);
}

export function removeDaemonFile(home: string, token: string): void {
  if (readDaemonFile(home)?.token === token) {
    rmSync(join(home, "daemon.json"));
  }
}

export function daemonUrl(record: Pick<DaemonFile, "port" | "token">): string {
  return `http://127.0.0.1:${record.port}/#token=${record.token}`;
}
