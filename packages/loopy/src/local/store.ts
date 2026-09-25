import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { AttemptRecord, Json, RunEvent, RunRecord, RunStatus } from "../core/model.js";
import { RunBusyError } from "../runtime/errors.js";
import type { RunRepository } from "../runtime/repository.js";

export { RunBusyError } from "../runtime/errors.js";

type RunRow = {
  id: string;
  slug: string;
  workflow_json: string;
  workflow_hash: string;
  input_json: string;
  options_json: string;
  status: RunStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
  owner_token: string | null;
  owner_pid: number | null;
  owner_host: string | null;
  heartbeat_at: string | null;
};

type AttemptRow = {
  id: string;
  run_id: string;
  node_id: string;
  number: number;
  status: AttemptRecord["status"];
  input_json: string;
  output_json: string | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
};

type EventRow = {
  sequence: number;
  run_id: string;
  node_id: string | null;
  type: string;
  data_json: string;
  created_at: string;
};

const now = () => new Date().toISOString();
const encode = (value: Json) => JSON.stringify(value);
const decode = <T>(value: string): T => JSON.parse(value) as T;

function runFromRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    slug: row.slug,
    workflow: decode(row.workflow_json),
    workflowHash: row.workflow_hash,
    input: decode(row.input_json),
    options: decode(row.options_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.error ? { error: row.error } : {}),
  };
}

function attemptFromRow(row: AttemptRow): AttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    number: row.number,
    status: row.status,
    input: decode(row.input_json),
    ...(row.output_json === null ? {} : { output: decode(row.output_json) }),
    ...(row.error === null ? {} : { error: row.error }),
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  };
}

function eventFromRow(row: EventRow): RunEvent {
  return {
    sequence: row.sequence,
    runId: row.run_id,
    ...(row.node_id === null ? {} : { nodeId: row.node_id }),
    type: row.type,
    data: decode(row.data_json),
    createdAt: row.created_at,
  };
}

function ownerAlive(row: RunRow): boolean {
  if (!row.owner_token || !row.owner_pid || row.owner_host !== hostname()) return false;
  try {
    process.kill(row.owner_pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ownerActive(row: RunRow): boolean {
  if (ownerAlive(row)) return true;
  return Boolean(row.owner_token && row.owner_host !== hostname());
}

/** One SQLite owner for run state, node attempts, and ordered events. */
export class SqliteRunStore implements RunRepository {
  private readonly db: Database;

  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = join(home, "runs.sqlite");
    this.db = new Database(file, { create: true });
    chmodSync(file, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON",
    );
    const version = this.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()?.user_version;
    if (version !== 0 && version !== 1 && version !== 2) {
      this.db.close();
      throw new Error(`Unsupported run database version ${version}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        workflow_json TEXT NOT NULL,
        workflow_hash TEXT NOT NULL,
        input_json TEXT NOT NULL,
        options_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        owner_token TEXT,
        owner_pid INTEGER,
        owner_host TEXT,
        heartbeat_at TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_slug_created ON runs(slug, created_at DESC);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        number INTEGER NOT NULL CHECK(number > 0),
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        UNIQUE(run_id, node_id, number)
      );
      CREATE INDEX IF NOT EXISTS attempts_run ON attempts(run_id, node_id, number);
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        node_id TEXT,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence)
      );
    `);
    if (version === 1) {
      this.db
        .transaction(() => {
          const current = this.db
            .query<{ user_version: number }, []>("PRAGMA user_version")
            .get()?.user_version;
          if (current === 2) return;
          if (current !== 1) throw new Error(`Unsupported run database version ${current}`);
          const rows = this.db
            .query<{ id: string; options_json: string }, []>("SELECT id,options_json FROM runs")
            .all();
          for (const row of rows) {
            const options: unknown = JSON.parse(row.options_json);
            if (
              !options ||
              typeof options !== "object" ||
              !("cwd" in options) ||
              typeof options.cwd !== "string" ||
              !("mode" in options) ||
              (options.mode !== "sandbox" && options.mode !== "full")
            )
              throw new Error(`Invalid run options in ${row.id}`);
            this.db.run("UPDATE runs SET options_json=? WHERE id=?", [
              JSON.stringify({
                workspace: { kind: "local", path: options.cwd },
                mode: options.mode,
              }),
              row.id,
            ]);
          }
          this.db.exec("PRAGMA user_version=2");
        })
        .immediate();
    } else if (version === 0) {
      this.db.exec("PRAGMA user_version=2");
    }
    this.recoverOrphans();
  }

  /** A dead owner cannot leave a run looking active or silently replay its command. */
  recoverOrphans(): void {
    const rows = this.db.query<RunRow, []>("SELECT * FROM runs WHERE status='running'").all();
    for (const row of rows) {
      if (ownerActive(row)) continue;
      this.db.transaction(() => {
        const current = this.db
          .query<RunRow, [string]>("SELECT * FROM runs WHERE id=?")
          .get(row.id);
        if (
          !current ||
          current.status !== "running" ||
          current.owner_token !== row.owner_token ||
          ownerActive(current)
        )
          return;
        const attempts = this.db
          .query<AttemptRow, [string]>("SELECT * FROM attempts WHERE run_id=? AND status='running'")
          .all(row.id);
        for (const attempt of attempts) {
          this.db.run("UPDATE attempts SET status='uncertain',error=?,ended_at=? WHERE id=?", [
            "Execution owner stopped before recording a result",
            now(),
            attempt.id,
          ]);
          this.event(row.id, "node.uncertain", { attemptId: attempt.id }, attempt.node_id);
        }
        this.db.run(
          "UPDATE runs SET status='interrupted',error=?,owner_token=NULL,owner_pid=NULL,owner_host=NULL,heartbeat_at=NULL,updated_at=? WHERE id=?",
          ["Execution owner stopped before recording a result", now(), row.id],
        );
        this.event(row.id, "run.interrupted", { uncertainAttempts: attempts.length });
      })();
    }
  }

  /** Explicitly fence an owner from another host when its liveness cannot be checked locally. */
  recoverOwner(runId: string): RunRecord {
    this.recoverOrphans();
    return this.db.transaction(() => {
      const row = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id=?").get(runId);
      if (!row) throw new Error(`Unknown run ${runId}`);
      if (!row.owner_token) {
        if (row.status === "interrupted") return runFromRow(row);
        throw new Error(`Run ${runId} has no owner to recover`);
      }
      if (!row.owner_host || row.owner_host === hostname()) {
        if (ownerAlive(row)) throw new RunBusyError(runId);
        throw new Error(`Run ${runId} has no foreign owner to recover`);
      }

      const attempts = this.db
        .query<AttemptRow, [string]>("SELECT * FROM attempts WHERE run_id=? AND status='running'")
        .all(runId);
      for (const attempt of attempts) {
        this.db.run("UPDATE attempts SET status='uncertain',error=?,ended_at=? WHERE id=?", [
          "Foreign execution owner was explicitly recovered before recording a result",
          now(),
          attempt.id,
        ]);
        this.event(runId, "node.uncertain", { attemptId: attempt.id }, attempt.node_id);
      }
      const status = row.status === "succeeded" ? "succeeded" : "interrupted";
      const error =
        status === "interrupted" ? "Foreign execution owner was explicitly recovered" : null;
      this.db.run(
        "UPDATE runs SET status=?,error=?,owner_token=NULL,owner_pid=NULL,owner_host=NULL,heartbeat_at=NULL,updated_at=? WHERE id=? AND owner_token=?",
        [status, error, now(), runId, row.owner_token],
      );
      this.event(runId, "run.owner_recovered", {
        previousOwnerHost: row.owner_host,
        previousOwnerPid: row.owner_pid,
        previousStatus: row.status,
        uncertainAttempts: attempts.length,
      });
      if (row.status === "running")
        this.event(runId, "run.interrupted", { uncertainAttempts: attempts.length });
      const recovered = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id=?").get(runId);
      return runFromRow(recovered as RunRow);
    })();
  }

  private event(runId: string, type: string, data: Json, nodeId?: string): void {
    const next =
      this.db
        .query<{ sequence: number }, [string]>(
          "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM events WHERE run_id=?",
        )
        .get(runId)?.sequence ?? 0;
    this.db.run(
      "INSERT INTO events(run_id,sequence,node_id,type,data_json,created_at) VALUES (?,?,?,?,?,?)",
      [runId, next, nodeId ?? null, type, encode(data), now()],
    );
  }

  async createRun(run: RunRecord): Promise<void> {
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO runs(id,slug,workflow_json,workflow_hash,input_json,options_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          run.id,
          run.slug,
          encode(run.workflow as Json),
          run.workflowHash,
          encode(run.input),
          encode(run.options as Json),
          run.status,
          run.createdAt,
          run.updatedAt,
        ],
      );
      this.event(run.id, "run.created", { slug: run.slug, workflowHash: run.workflowHash });
    })();
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    this.recoverOrphans();
    const row = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id=?").get(id);
    return row ? runFromRow(row) : undefined;
  }

  async listRuns(slug?: string): Promise<RunRecord[]> {
    this.recoverOrphans();
    const rows = slug
      ? this.db
          .query<RunRow, [string]>(
            "SELECT * FROM runs WHERE slug=? ORDER BY created_at DESC,id DESC",
          )
          .all(slug)
      : this.db.query<RunRow, []>("SELECT * FROM runs ORDER BY created_at DESC,id DESC").all();
    return rows.map(runFromRow);
  }

  async getAttempts(runId: string): Promise<AttemptRecord[]> {
    return this.db
      .query<AttemptRow, [string]>("SELECT * FROM attempts WHERE run_id=? ORDER BY rowid")
      .all(runId)
      .map(attemptFromRow);
  }

  async getEvents(runId: string, after = -1): Promise<RunEvent[]> {
    return this.db
      .query<EventRow, [string, number]>(
        "SELECT * FROM events WHERE run_id=? AND sequence>? ORDER BY sequence",
      )
      .all(runId, after)
      .map(eventFromRow);
  }

  /** Claims a run with compare-and-set. A live local owner cannot be displaced. */
  async claim(
    runId: string,
    token: string,
    options: { resume?: boolean } = {},
  ): Promise<RunRecord> {
    return this.db.transaction(() => {
      const row = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id=?").get(runId);
      if (!row) throw new Error(`Unknown run ${runId}`);
      if (
        row.status === "succeeded" ||
        (options.resume === false && (row.status === "failed" || row.status === "interrupted"))
      )
        return runFromRow(row);
      if (ownerActive(row)) throw new RunBusyError(runId);
      const claimed = this.db.run(
        "UPDATE runs SET owner_token=?,owner_pid=?,owner_host=?,heartbeat_at=?,status='running',error=NULL,updated_at=? WHERE id=? AND owner_token IS ?",
        [token, process.pid, hostname(), now(), now(), runId, row.owner_token],
      );
      if (claimed.changes !== 1) throw new RunBusyError(runId);
      const interrupted = this.db
        .query<AttemptRow, [string]>("SELECT * FROM attempts WHERE run_id=? AND status='running'")
        .all(runId);
      for (const attempt of interrupted) {
        this.db.run("UPDATE attempts SET status='uncertain',error=?,ended_at=? WHERE id=?", [
          "Previous process stopped before recording a result",
          now(),
          attempt.id,
        ]);
        this.event(runId, "node.uncertain", { attemptId: attempt.id }, attempt.node_id);
      }
      this.event(runId, row.status === "pending" ? "run.started" : "run.resumed", {});
      const claimedRow = this.db
        .query<RunRow, [string]>("SELECT * FROM runs WHERE id=?")
        .get(runId);
      return runFromRow(claimedRow as RunRow);
    })();
  }

  async heartbeat(runId: string, token: string): Promise<boolean> {
    return (
      this.db.run(
        "UPDATE runs SET heartbeat_at=? WHERE id=? AND owner_token=? AND status='running'",
        [now(), runId, token],
      ).changes === 1
    );
  }

  async startAttempt(
    runId: string,
    token: string,
    nodeId: string,
    input: Json,
  ): Promise<AttemptRecord> {
    return this.db.transaction(() => {
      this.assertOwner(runId, token);
      const number =
        this.db
          .query<{ number: number }, [string, string]>(
            "SELECT COALESCE(MAX(number),0)+1 AS number FROM attempts WHERE run_id=? AND node_id=?",
          )
          .get(runId, nodeId)?.number ?? 1;
      const attempt: AttemptRecord = {
        id: randomUUID(),
        runId,
        nodeId,
        number,
        status: "running",
        input,
        startedAt: now(),
      };
      this.db.run(
        "INSERT INTO attempts(id,run_id,node_id,number,status,input_json,started_at) VALUES (?,?,?,?,?,?,?)",
        [attempt.id, runId, nodeId, number, attempt.status, encode(input), attempt.startedAt],
      );
      this.event(runId, "node.started", { attemptId: attempt.id, number }, nodeId);
      return attempt;
    })();
  }

  async finishAttempt(
    runId: string,
    token: string,
    attemptId: string,
    status: "succeeded" | "failed" | "uncertain",
    output?: Json,
    error?: string,
  ): Promise<AttemptRecord> {
    return this.db.transaction(() => {
      this.assertOwner(runId, token);
      const row = this.db
        .query<AttemptRow, [string, string]>("SELECT * FROM attempts WHERE id=? AND run_id=?")
        .get(attemptId, runId);
      if (!row || row.status !== "running") throw new Error(`Attempt ${attemptId} is not running`);
      const endedAt = now();
      this.db.run("UPDATE attempts SET status=?,output_json=?,error=?,ended_at=? WHERE id=?", [
        status,
        output === undefined ? null : encode(output),
        error ?? null,
        endedAt,
        attemptId,
      ]);
      this.event(runId, `node.${status}`, { attemptId, ...(error ? { error } : {}) }, row.node_id);
      return attemptFromRow({
        ...row,
        status,
        output_json: output === undefined ? null : encode(output),
        error: error ?? null,
        ended_at: endedAt,
      });
    })();
  }

  async finishRun(
    runId: string,
    token: string,
    status: RunStatus,
    error?: string,
  ): Promise<RunRecord> {
    return this.db.transaction(() => {
      this.assertOwner(runId, token);
      this.db.run("UPDATE runs SET status=?,error=?,updated_at=? WHERE id=?", [
        status,
        error ?? null,
        now(),
        runId,
      ]);
      this.event(runId, `run.${status}`, error ? { error } : {});
      const completedRow = this.db
        .query<RunRow, [string]>("SELECT * FROM runs WHERE id=?")
        .get(runId);
      return runFromRow(completedRow as RunRow);
    })();
  }

  async release(runId: string, token: string): Promise<void> {
    this.db.run(
      "UPDATE runs SET owner_token=NULL,owner_pid=NULL,owner_host=NULL,heartbeat_at=NULL WHERE id=? AND owner_token=?",
      [runId, token],
    );
  }

  private assertOwner(runId: string, token: string): void {
    if (!this.db.query("SELECT 1 FROM runs WHERE id=? AND owner_token=?").get(runId, token))
      throw new RunBusyError(runId);
  }

  close(): void {
    this.db.close();
  }
}
