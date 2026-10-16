import { Database } from "bun:sqlite";
import { hostname } from "node:os";
import type {
  EngineLog,
  EngineRun,
  EngineRunStatus,
  EngineStep,
  RunOutcome,
} from "../core/index.js";
import { OwnershipError, type RunStore } from "../runtime/index.js";
import { rowToLog, rowToRun, rowToStep, SQL, stepToRow } from "./engine-store-rows.js";
import {
  type LogRow,
  type RunRow,
  SCHEMA,
  SCHEMA_VERSION,
  type StepRow,
} from "./engine-store-schema.js";

export class SqliteRunStore implements RunStore {
  private readonly db: Database;

  constructor(
    file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = new Database(file, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    this.db
      .transaction(() => {
        const version = this.db
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get()?.user_version;

        if (version === SCHEMA_VERSION) {
          return;
        }

        const tables = this.db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all();

        // Defer foreign keys until every old table has been dropped.
        this.db.exec("PRAGMA defer_foreign_keys=ON");

        for (const table of tables) {
          this.db.exec(`DROP TABLE "${table.name.replaceAll('"', '""')}"`);
        }

        this.db.exec(SCHEMA);
        this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      })
      .immediate();
  }

  async createRun(run: EngineRun): Promise<void> {
    this.db
      .transaction(() => {
        if (this.row(run.id)) {
          throw new Error(`Run '${run.id}' already exists. Use a new run ID.`);
        }

        this.db
          .query(SQL.createRun)
          .run(
            run.id,
            run.slug,
            run.bundleHash,
            JSON.stringify(run.input),
            run.status,
            run.output === undefined ? null : JSON.stringify(run.output),
            run.error ?? null,
            run.wakeAt === undefined ? null : new Date(run.wakeAt).toISOString(),
            new Date(run.createdAt).toISOString(),
            new Date(run.updatedAt).toISOString(),
            run.owner?.token ?? null,
            run.owner?.pid ?? null,
            run.owner?.host ?? null,
            run.owner === undefined ? null : new Date(run.owner.heartbeatAt).toISOString(),
          );
      })
      .immediate();
  }

  async getRun(id: string): Promise<EngineRun | undefined> {
    const row = this.row(id);

    return row ? rowToRun(row) : undefined;
  }

  async listRuns(filter: { slug?: string; status?: EngineRunStatus } = {}): Promise<EngineRun[]> {
    if (filter.slug !== undefined && filter.status !== undefined) {
      return this.db
        .query<RunRow, [string, EngineRunStatus]>(SQL.listRunsBySlugAndStatus)
        .all(filter.slug, filter.status)
        .map(rowToRun);
    }

    if (filter.slug !== undefined) {
      return this.db.query<RunRow, [string]>(SQL.listRunsBySlug).all(filter.slug).map(rowToRun);
    }

    if (filter.status !== undefined) {
      return this.db
        .query<RunRow, [EngineRunStatus]>(SQL.listRunsByStatus)
        .all(filter.status)
        .map(rowToRun);
    }

    return this.db.query<RunRow, []>(SQL.listRuns).all().map(rowToRun);
  }

  async claim(runId: string, token: string): Promise<EngineRun> {
    return this.db
      .transaction(() => {
        const timestamp = this.timestamp();

        const result = this.db
          .query(SQL.claim)
          .run(token, process.pid, hostname(), timestamp, timestamp, runId);

        if (result.changes !== 1) {
          const row = this.requireRow(runId);

          if (row.owner_token !== null) {
            throw new OwnershipError(runId);
          }

          throw new Error(
            `Run '${runId}' cannot be claimed in status '${row.status}'. Activate a queued or suspended run.`,
          );
        }

        return rowToRun(this.requireRow(runId));
      })
      .immediate();
  }

  async heartbeat(runId: string, token: string): Promise<boolean> {
    return this.db
      .transaction(() => {
        this.requireRow(runId);
        const timestamp = this.timestamp();

        return this.db.query(SQL.heartbeat).run(timestamp, timestamp, runId, token).changes === 1;
      })
      .immediate();
  }

  async suspend(runId: string, token: string, wakeAt?: string): Promise<void> {
    this.db
      .transaction(() => {
        this.requireRunning(this.owned(runId, token));
        this.db
          .query(SQL.suspend)
          .run(
            wakeAt === undefined ? null : new Date(wakeAt).toISOString(),
            this.timestamp(),
            runId,
            token,
          );
      })
      .immediate();
  }

  async finishRun(runId: string, token: string, outcome: RunOutcome): Promise<void> {
    this.db
      .transaction(() => {
        this.requireRunning(this.owned(runId, token));
        this.db
          .query(SQL.finish)
          .run(
            outcome.status,
            outcome.status === "succeeded" ? JSON.stringify(outcome.output) : null,
            outcome.status === "failed" ? outcome.error : null,
            this.timestamp(),
            runId,
            token,
          );
      })
      .immediate();
  }

  async release(runId: string, token: string): Promise<void> {
    this.db
      .transaction(() => {
        this.owned(runId, token);
        const timestamp = this.timestamp();
        this.db.query(SQL.release).run(timestamp, timestamp, runId, token);
      })
      .immediate();
  }

  async getSteps(runId: string): Promise<EngineStep[]> {
    return this.db.query<StepRow, [string]>(SQL.steps).all(runId).map(rowToStep);
  }

  async putStep(runId: string, token: string, step: EngineStep): Promise<void> {
    this.db
      .transaction(() => {
        this.owned(runId, token);
        const row = stepToRow(step);
        this.db
          .query(SQL.putStep)
          .run(
            runId,
            row.seq,
            row.key,
            row.kind,
            row.input_json,
            row.attempt,
            row.max_attempts,
            row.started_at,
            row.status,
            row.output_json,
            row.error,
            row.next_retry_at,
            row.wake_at,
            row.finish_order,
            row.ended_at,
          );
      })
      .immediate();
  }

  async appendLog(runId: string, token: string, log: EngineLog): Promise<void> {
    this.db
      .transaction(() => {
        this.owned(runId, token);

        try {
          this.db
            .query(SQL.appendLog)
            .run(
              runId,
              log.seq,
              log.position.kind,
              log.position.kind === "workflow" ? log.position.afterStep : null,
              log.position.kind === "workflow" ? log.position.afterFinish : null,
              log.position.kind === "step" ? log.position.seq : null,
              log.position.kind === "step" ? log.position.attempt : null,
              log.position.index,
              log.level,
              log.message,
              log.data === undefined ? null : JSON.stringify(log.data),
              new Date(log.at).toISOString(),
            );
        } catch (error) {
          if (this.db.query(SQL.logExists).get(runId, log.seq)) {
            throw new Error(
              `Log sequence ${log.seq} already exists. Append a new sequence number.`,
            );
          }

          throw error;
        }
      })
      .immediate();
  }

  async getLogs(runId: string, after = 0): Promise<EngineLog[]> {
    return this.db.query<LogRow, [string, number]>(SQL.logs).all(runId, after).map(rowToLog);
  }

  async dueRuns(now: string): Promise<EngineRun[]> {
    return this.db
      .query<RunRow, [string]>(SQL.dueRuns)
      .all(new Date(now).toISOString())
      .map(rowToRun);
  }

  close(): void {
    this.db.close();
  }

  private row(runId: string): RunRow | undefined {
    return this.db.query<RunRow, [string]>(SQL.run).get(runId) ?? undefined;
  }

  private requireRow(runId: string): RunRow {
    const row = this.row(runId);

    if (!row) {
      throw new Error(`Run '${runId}' does not exist. Create the run first.`);
    }

    return row;
  }

  private owned(runId: string, token: string): RunRow {
    const row = this.requireRow(runId);

    if (row.owner_token !== token) {
      throw new OwnershipError(runId);
    }

    return row;
  }

  private requireRunning(row: RunRow): void {
    if (row.status !== "running") {
      throw new Error(
        `Run '${row.id}' cannot transition from '${row.status}'. Claim a queued or suspended run first.`,
      );
    }
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}
