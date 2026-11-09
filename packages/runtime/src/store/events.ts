import type { LogRecord, RuntimeEvent, RuntimeEventChange } from "@loopy/core";
import type { SqlContext, SqlWrite } from "./context";
import { StoredDataError } from "./operation";
import { type EventRow, rowToEvent } from "./rows";

export const EVENT_RETENTION = { maxAgeMs: 86_400_000, maxRows: 100_000 } as const;

type EventParams = [
  string,
  string,
  string,
  string,
  string | null,
  string,
  string | null,
  string | null,
  string | null,
];

function append(write: SqlWrite, change: RuntimeEventChange, nodeId: string | null): void {
  const scoped = change.entity === "run" || change.entity === "schedule";

  const row = write.db
    .query<Pick<EventRow, "sequence">, EventParams>(
      "INSERT INTO events(at,txn,entity,kind,run_id,record,node_id,slug,workspace) VALUES (?,?,?,?,?,?,?,?,?) RETURNING sequence",
    )
    .get(
      write.at,
      write.txn,
      change.entity,
      change.kind,
      change.runId,
      JSON.stringify(change.record),
      nodeId,
      scoped ? change.record.slug : null,
      scoped ? change.record.workspace : null,
    );

  if (!row) {
    throw new Error("Event was not appended. Restore storage.");
  }

  const event: RuntimeEvent = {
    ...change,
    sequence: row.sequence,
    at: write.at,
    txn: write.txn,
  };

  write.events.push(event);
}

export function emit(
  write: SqlWrite,
  change: Exclude<RuntimeEventChange, { entity: "log" }>,
): void {
  append(write, change, change.entity === "node" ? change.record.key.nodeId : null);
}

export function emitLog(write: SqlWrite, record: LogRecord, nodeId: string): void {
  append(write, { entity: "log", kind: "written", runId: record.runId, record }, nodeId);
}

export function readEvents(ctx: SqlContext, after: number, limit: number) {
  return ctx.db
    .query<EventRow, [number, number]>(
      "SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?",
    )
    .all(after, limit)
    .map(rowToEvent);
}

export function readTransactionEvents(ctx: SqlContext, txn: string, after: number) {
  return ctx.db
    .query<EventRow, [string, number]>(
      "SELECT * FROM events WHERE txn=? AND sequence>? ORDER BY sequence",
    )
    .all(txn, after)
    .map(rowToEvent);
}

export function readEvent(ctx: SqlContext, sequence: number) {
  const row = ctx.db
    .query<EventRow, [number]>("SELECT * FROM events WHERE sequence=?")
    .get(sequence);

  return row ? rowToEvent(row) : undefined;
}

export function readOldestEventSequence(ctx: SqlContext) {
  return (
    ctx.db
      .query<{ oldest: number | null }, []>(
        "SELECT COALESCE(MIN(sequence), (SELECT seq + 1 FROM sqlite_sequence WHERE name='events')) AS oldest FROM events",
      )
      .get()?.oldest ?? undefined
  );
}

export function readEpoch(ctx: SqlContext): string {
  const row = ctx.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='epoch'").get();

  if (!row) {
    throw new StoredDataError("Store epoch is missing. Recreate the database.");
  }

  return row.value;
}

export function readEventCursor(ctx: SqlContext) {
  return {
    cursor:
      ctx.db
        .query<{ cursor: number }, []>(
          "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0) AS cursor",
        )
        .get()?.cursor ?? 0,
    epoch: readEpoch(ctx),
  };
}

// Advancing through the last affected transaction prevents replaying a retained tail.
const PRUNE_EVENTS = `WITH boundary AS (
    SELECT MAX(sequence) AS sequence FROM events WHERE at<? OR sequence<=COALESCE(
      (SELECT sequence FROM events ORDER BY sequence DESC LIMIT 1 OFFSET ${EVENT_RETENTION.maxRows}),0
    )
  ), transaction_end AS (
    SELECT MAX(sequence) AS sequence FROM events WHERE txn IN (
      SELECT txn FROM events WHERE sequence<=(SELECT sequence FROM boundary)
    )
  ) DELETE FROM events WHERE sequence<=(SELECT sequence FROM transaction_end)`;

export function pruneEvents(ctx: SqlContext, now: string): number {
  const cutoff = new Date(Date.parse(now) - EVENT_RETENTION.maxAgeMs).toISOString();

  return ctx.db.query(PRUNE_EVENTS).run(cutoff).changes;
}
