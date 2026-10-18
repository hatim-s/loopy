import { existsSync, readFileSync, rmSync } from "node:fs";
import { z } from "zod";
import { processAlive, writeFileAtomically } from "../executor/index.js";
import { homePaths } from "./home.js";

const daemonFileSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int(),
  token: z.string(),
  startedAt: z.string(),
});

type DaemonFile = z.infer<typeof daemonFileSchema>;

export function readDaemonFile(home: string): DaemonFile | undefined {
  const file = homePaths(home).daemonFile;

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
  await writeFileAtomically(homePaths(home).daemonFile, `${JSON.stringify(record)}\n`, {
    mode: 0o600,
    syncDirectory: true,
  });
}

export function removeDaemonFile(home: string, token: string): void {
  if (readDaemonFile(home)?.token === token) {
    rmSync(homePaths(home).daemonFile);
  }
}

export function daemonUrl(record: Pick<DaemonFile, "port" | "token">): string {
  return `http://127.0.0.1:${record.port}/#token=${record.token}`;
}
