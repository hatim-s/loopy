import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { errnoCode, writeFileAtomically } from "./fs.js";

const daemonFileSchema = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
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

  const record = Schema.decodeUnknownSync(daemonFileSchema)(JSON.parse(readFileSync(file, "utf8")));

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
