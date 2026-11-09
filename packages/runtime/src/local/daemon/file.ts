import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decodeJson } from "@loopy/contract";
import { positiveInt } from "@loopy/core";
import { Schema } from "effect";
import { processAlive, writeFileAtomically } from "../../os";

const daemonFileSchema = Schema.Struct({
  pid: positiveInt,
  port: Schema.Int,
  token: Schema.String,
  startedAt: Schema.String,
});

type DaemonFile = typeof daemonFileSchema.Type;

export function readDaemonFile(home: string): DaemonFile | undefined {
  const file = join(home, "daemon.json");

  if (!existsSync(file)) {
    return undefined;
  }

  const record = decodeJson(daemonFileSchema)(readFileSync(file, "utf8"));

  return processAlive(record.pid) ? record : undefined;
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
