import type { RunOutcome, RunRecord, RunStatus, RuntimeEvent } from "../../core/index.js";
import {
  acquireWindow,
  isTerminalRun,
  OwnershipError,
  type RateLimitWindow,
} from "../../core/index.js";
import { type EventTransaction } from "../event-outbox.js";
import { ownedStorageOperation, StoreRejectedError, storageOperation } from "../operation.js";
import { normalizeRun, utc } from "../timestamps.js";
import { rowToRun, SQL } from "./store-rows.js";
import { type RunRow } from "./store-schema.js";
import { SqliteWaitRecords } from "./wait-records.js";

export class SqliteRuns extends SqliteWaitRecords {
  acquireRateLimit(key: string, count: number, windowMs: number, now: string) {
    return storageOperation("acquireRateLimit", () => {
      return this.db.transaction(() => {
        const window =
          this.db.query<RateLimitWindow, [string]>(SQL.rateLimit).get(key) ?? undefined;

        const acquired = acquireWindow(window, count, windowMs, now);
        this.db
          .query(SQL.putRateLimit)
          .run(key, acquired.window.windowStart, acquired.window.count);

        return acquired.result;
      }, "immediate");
    });
  }

  createRun(run: RunRecord) {
    return storageOperation("createRun", () => {
      this.commit((txn) => {
        if (this.row(run.id)) {
          throw new StoreRejectedError(`Run '${run.id}' already exists. Use a new run ID.`);
        }

        this.insertRun(run);
        this.emitRun(txn, run.id, "created");
      });
    });
  }

  getRun(id: string) {
    return storageOperation("getRun", () => {
      const row = this.row(id);

      return row ? rowToRun(row) : undefined;
    });
  }

  listRuns(filter: { slug?: string; status?: RunStatus } = {}) {
    return storageOperation("listRuns", () => {
      return this.db
        .query<RunRow, [string | null, RunStatus | null]>(SQL.listRuns)
        .all(filter.slug ?? null, filter.status ?? null)
        .map(rowToRun);
    });
  }

  claim(runId: string, token: string) {
    return ownedStorageOperation("claim", () => {
      return this.commit((txn) => {
        const timestamp = this.timestamp();

        const previous = this.requireRow(runId);

        if (this.stale(previous, this.now())) {
          this.recoverRun(txn, previous, timestamp);
        }

        const result = this.db
          .query(SQL.claim)
          .run(
            token,
            this.options.owner.identity.pid,
            this.options.owner.identity.host,
            timestamp,
            timestamp,
            runId,
          );

        if (result.changes !== 1) {
          const row = this.requireRow(runId);

          if (row.owner_token !== null) {
            throw new OwnershipError(runId);
          }

          throw new StoreRejectedError(
            `Run '${runId}' cannot be claimed in status '${row.status}'. Activate a queued or suspended run.`,
          );
        }

        this.emitRun(txn, runId, "claimed");

        return rowToRun(this.requireRow(runId));
      });
    });
  }

  protected recoverRun(txn: EventTransaction, previous: RunRow, timestamp: string): void {
    const runId = previous.id;
    this.db.query(SQL.release).run(timestamp, timestamp, runId, previous.owner_token);
    this.emitRun(txn, runId, "released");
  }

  wakeRun(id: string, at: string) {
    return storageOperation("wakeRun", () => {
      return this.commit((txn) => {
        const row = this.row(id);

        if (!row) {
          return "not_found";
        }

        if (row.owner_token !== null) {
          if (!this.stale(row, this.now())) {
            return "owned_elsewhere";
          }

          this.recoverRun(txn, row, at);
        }

        if (isTerminalRun(row.status)) {
          return "not_claimable";
        }

        this.db.query(SQL.wakeRun).run(utc(at), utc(at), id);
        this.emitRun(txn, id, "woken");

        return undefined;
      });
    });
  }

  heartbeat(runId: string, token: string) {
    return storageOperation("heartbeat", () => {
      return this.commit((txn) => {
        this.requireRow(runId);
        const timestamp = this.timestamp();

        const changed =
          this.db.query(SQL.heartbeat).run(timestamp, timestamp, runId, token).changes === 1;

        if (changed) {
          this.emitRun(txn, runId, "heartbeat");
        }

        return changed;
      });
    });
  }

  suspend(runId: string, token: string, wakeAt?: string) {
    return ownedStorageOperation("suspend", () => {
      this.commit((txn) => {
        const run = this.owned(runId, token);
        this.requireRunning(run);

        this.db
          .query(SQL.suspend)
          .run(wakeAt === undefined ? null : utc(wakeAt), this.timestamp(), runId, token);
        this.emitRun(txn, runId, "suspended");
      });
    });
  }

  finishRun(runId: string, token: string, outcome: RunOutcome) {
    return ownedStorageOperation("finishRun", () => {
      this.commit((txn) => {
        this.requireRunning(this.owned(runId, token));
        this.expireWaits(txn, runId, this.timestamp());
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
        this.emitRun(txn, runId, "finished");
      });
    });
  }

  release(runId: string, token: string) {
    return ownedStorageOperation("release", () => {
      this.commit((txn) => {
        const previous = this.owned(runId, token);
        const timestamp = this.timestamp();
        this.db.query(SQL.release).run(timestamp, timestamp, runId, token);
        this.emitRun(txn, runId, "released");

        if (previous.status === "running") {
          this.emitRun(txn, runId, "suspended");
        }
      });
    });
  }

  dueRuns(now: string) {
    return storageOperation("dueRuns", () => {
      return this.db
        .query<RunRow, [string]>(SQL.dueRuns)
        .all(utc(now))
        .filter((row) => row.owner_token === null || this.stale(row, Date.parse(now)))
        .map(rowToRun);
    });
  }

  nextWakeAt() {
    return storageOperation("nextWakeAt", () => {
      return (
        this.db.query<{ wake_at: string | null }, []>(SQL.nextWakeAt).get()?.wake_at ?? undefined
      );
    });
  }

  protected emitRun(
    txn: EventTransaction,
    runId: string,
    kind: Extract<RuntimeEvent, { entity: "run" }>["kind"],
  ): void {
    this.emit(txn, { entity: "run", kind, runId, record: rowToRun(this.requireRow(runId)) });
  }

  protected insertRun(input: RunRecord): void {
    const run = normalizeRun(input);

    this.db
      .query(SQL.createRun)
      .run(
        run.id,
        run.slug,
        run.revision,
        run.workspace,
        JSON.stringify(run.input),
        run.status,
        run.output === undefined ? null : JSON.stringify(run.output),
        run.error ?? null,
        run.wakeAt ?? null,
        run.nextRetryAt ?? null,
        run.createdAt,
        run.updatedAt,
        run.owner?.token ?? null,
        run.owner?.pid ?? null,
        run.owner?.host ?? null,
        run.owner?.heartbeatAt ?? null,
      );
  }
}
