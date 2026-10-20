import { Database } from "bun:sqlite";
import type { RuntimeEvent, RuntimeEventChange } from "../../core/index.js";
import { EVENT_RETENTION, EventListeners, type EventTransaction } from "../event-outbox.js";
import { rowToEvent, SQL } from "./store-rows.js";
import { type EventRow, SCHEMA, SCHEMA_VERSION, WAIT_SCHEMA } from "./store-schema.js";

export class SqliteEvents {
  protected readonly db: Database;

  get leaseMs(): number {
    return this.options.leaseMs ?? 60_000;
  }

  constructor(
    file: string,
    protected readonly now: () => number = Date.now,
    protected readonly options: { leaseMs?: number } = {},
  ) {
    this.db = new Database(file, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");

    try {
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

          if (version === 13) {
            this.db.exec(WAIT_SCHEMA);
            this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);

            return;
          }

          if (tables.length > 0 || version !== 0) {
            throw new Error(
              `Database schema ${version} cannot be opened by this runtime. Preserve this home and migrate its saved definitions into a separate home.`,
            );
          }

          this.db.exec(SCHEMA);
          this.db.query(SQL.createEpoch).run(crypto.randomUUID());
          this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
        })
        .immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  dataVersion(): number {
    return (
      this.db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0
    );
  }

  oldestEventSequence(): number | undefined {
    return (
      this.db
        .query<{ oldest: number | null }, []>(
          "SELECT COALESCE(MIN(sequence), (SELECT seq + 1 FROM sqlite_sequence WHERE name='events')) AS oldest FROM events",
        )
        .get()?.oldest ?? undefined
    );
  }

  protected readonly listeners = new EventListeners();

  subscribe(listener: (events: RuntimeEvent[]) => void): () => void {
    return this.listeners.subscribe(listener);
  }

  async events(after: number, limit: number): Promise<RuntimeEvent[]> {
    return this.db.query<EventRow, [number, number]>(SQL.events).all(after, limit).map(rowToEvent);
  }

  async transactionEvents(txn: string, after: number): Promise<RuntimeEvent[]> {
    return this.db
      .query<EventRow, [string, number]>(SQL.transactionEvents)
      .all(txn, after)
      .map(rowToEvent);
  }

  async epoch(): Promise<string> {
    return this.readEpoch();
  }

  protected readEpoch(): string {
    const row = this.db.query<{ value: string }, []>(SQL.epoch).get();

    if (!row) {
      throw new Error("Store epoch is missing. Recreate the database.");
    }

    return row.value;
  }

  protected readEventCursor() {
    return {
      cursor: this.db.query<{ cursor: number }, []>(SQL.cursor).get()?.cursor ?? 0,
      epoch: this.readEpoch(),
    };
  }

  async eventCursor(): Promise<{ cursor: number; epoch: string }> {
    return this.db.transaction(() => this.readEventCursor()).deferred();
  }

  async pruneEvents(now: string): Promise<number> {
    const cutoff = new Date(Date.parse(now) - EVENT_RETENTION.maxAgeMs).toISOString();

    return this.db.query(SQL.pruneEvents).run(cutoff).changes;
  }

  protected commit<T>(change: (txn: EventTransaction) => T): T {
    const txn: EventTransaction = { id: crypto.randomUUID(), events: [] };
    const result = this.db.transaction(() => change(txn)).immediate();

    this.listeners.publish(txn.events);

    return result;
  }

  protected emit(txn: EventTransaction, change: RuntimeEventChange): void {
    const row = this.db
      .query<EventRow, [string, string, string, string, string | null, string]>(SQL.appendEvent)
      .get(
        this.timestamp(),
        txn.id,
        change.entity,
        change.kind,
        change.runId,
        JSON.stringify(change.record),
      );

    if (!row) {
      throw new Error("Event was not appended. Restore storage.");
    }

    txn.events.push(rowToEvent(row));
  }

  close(): void {
    this.db.close();
  }

  protected timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}
