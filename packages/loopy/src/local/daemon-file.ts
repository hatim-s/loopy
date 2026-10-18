import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { processAlive, writeFileAtomically } from "../executor/index.js";

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

  if (!processAlive(record.pid)) {
    return undefined;
  }

  return record;
}

export async function writeDaemonFile(home: string, record: DaemonFile): Promise<void> {
  await writeFileAtomically(join(home, "daemon.json"), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
    syncDirectory: true,
  });
}

export function removeDaemonFile(home: string, token: string): void {
  if (readDaemonFile(home)?.token === token) {
    rmSync(join(home, "daemon.json"));
  }
}

export function daemonUrl(record: Pick<DaemonFile, "port" | "token">): string {
  return `http://127.0.0.1:${record.port}/#token=${record.token}`;
}
