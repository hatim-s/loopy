import { type RuntimeEvent, type RuntimeEventChange, StoreError } from "../../core/index.js";
import type { EventTransaction } from "../event-outbox.js";
import { EVENT_RETENTION } from "../event-outbox.js";
import type { StoreContext } from "./context.js";
import type { EventRow } from "./store-schema.js";

const SQL = {
  createEpoch: "INSERT INTO meta VALUES ('epoch',?)",
  epoch: "SELECT value FROM meta WHERE key='epoch'",
  appendEvent:
    "INSERT INTO events(at,txn,entity,kind,run_id,record) VALUES (?,?,?,?,?,?) RETURNING *",
  events: "SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?",
  transactionEvents: "SELECT * FROM events WHERE txn=? AND sequence>? ORDER BY sequence",
  cursor: "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0) AS cursor",
  pruneEvents: `DELETE FROM events WHERE at<? OR sequence IN (SELECT sequence FROM events ORDER BY sequence DESC LIMIT -1 OFFSET ${EVENT_RETENTION.maxRows})`,
};

export function rowToEvent(row: EventRow): RuntimeEvent {
  const { run_id, record, ...event } = row;

  return { ...event, runId: run_id, record: JSON.parse(record) };
}

export function dataVersion(context: StoreContext): number {
  return (
    context.db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0
  );
}

export function oldestEventSequence(context: StoreContext): number | undefined {
  return (
    context.db
      .query<{ oldest: number | null }, []>(
        "SELECT COALESCE(MIN(sequence), (SELECT seq + 1 FROM sqlite_sequence WHERE name='events')) AS oldest FROM events",
      )
      .get()?.oldest ?? undefined
  );
}

export function subscribe(
  context: StoreContext,
  listener: (events: RuntimeEvent[]) => void,
): () => void {
  return context.listeners.subscribe(listener);
}

export async function events(
  context: StoreContext,
  after: number,
  limit: number,
): Promise<RuntimeEvent[]> {
  return context.db.query<EventRow, [number, number]>(SQL.events).all(after, limit).map(rowToEvent);
}

export async function transactionEvents(
  context: StoreContext,
  txn: string,
  after: number,
): Promise<RuntimeEvent[]> {
  return context.db
    .query<EventRow, [string, number]>(SQL.transactionEvents)
    .all(txn, after)
    .map(rowToEvent);
}

export async function epoch(context: StoreContext): Promise<string> {
  return readEpoch(context);
}

export function readEpoch(context: StoreContext): string {
  const row = context.db.query<{ value: string }, []>(SQL.epoch).get();

  if (!row) {
    throw new StoreError("missing_epoch");
  }

  return row.value;
}

export function readEventCursor(context: StoreContext) {
  return {
    cursor: context.db.query<{ cursor: number }, []>(SQL.cursor).get()?.cursor ?? 0,
    epoch: readEpoch(context),
  };
}

export async function eventCursor(
  context: StoreContext,
): Promise<{ cursor: number; epoch: string }> {
  return context.db.transaction(() => readEventCursor(context)).deferred();
}

export async function pruneEvents(context: StoreContext, now: string): Promise<number> {
  const cutoff = new Date(Date.parse(now) - EVENT_RETENTION.maxAgeMs).toISOString();

  return context.db.query(SQL.pruneEvents).run(cutoff).changes;
}

export function commit<T>(context: StoreContext, change: (txn: EventTransaction) => T): T {
  const txn: EventTransaction = { id: crypto.randomUUID(), events: [] };
  const result = context.db.transaction(() => change(txn)).immediate();

  context.listeners.publish(txn.events);

  return result;
}

export function emit(
  context: StoreContext,
  txn: EventTransaction,
  change: RuntimeEventChange,
): void {
  const row = context.db
    .query<EventRow, [string, string, string, string, string | null, string]>(SQL.appendEvent)
    .get(
      nowIso(context),
      txn.id,
      change.entity,
      change.kind,
      change.runId,
      JSON.stringify(change.record),
    );

  if (!row) {
    throw new StoreError("write_failed");
  }

  txn.events.push(rowToEvent(row));
}

export function close(context: StoreContext): void {
  context.db.close();
}

export function nowIso(context: StoreContext): string {
  return new Date(context.now()).toISOString();
}
