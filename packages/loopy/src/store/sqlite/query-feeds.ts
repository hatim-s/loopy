import type { SQLQueryBindings } from "bun:sqlite";
import type {
  EventPageQuery,
  EventSummary,
  LogPageQuery,
  LogSummary,
  RunStatus,
} from "../../core/index.js";
import { FEED_SCAN_LIMIT, scanPage } from "../query-utils.js";
import { SqliteQueryNodes } from "./query-nodes.js";
import { rowToEvent, rowToLog } from "./store-rows.js";
import type { EventRow } from "./store-schema.js";

function commonMatch(
  row: {
    runId: string | null;
    slug: string | null;
    workspace: string | null;
    status: RunStatus | null;
    at: string;
    nodeId: string | null;
  },
  query: LogPageQuery | EventPageQuery,
) {
  return (
    (query.runId === undefined || row.runId === query.runId) &&
    (query.slug === undefined || row.slug === query.slug) &&
    (query.workspace === undefined || row.workspace === query.workspace) &&
    (query.status === undefined || row.status === query.status) &&
    (query.nodeId === undefined || row.nodeId === query.nodeId) &&
    (query.from === undefined || row.at >= query.from) &&
    (query.to === undefined || row.at < query.to)
  );
}

export class SqliteQueryFeeds extends SqliteQueryNodes {
  private feedBounds(table: "logs" | "events", key: "id" | "sequence") {
    const oldest = this.db
      .query<{ key: number; at: string }, []>(
        `SELECT ${key} AS key,at FROM ${table} ORDER BY ${key} LIMIT 1`,
      )
      .get();

    const newest = this.db
      .query<{ key: number; at: string }, []>(
        `SELECT ${key} AS key,at FROM ${table} ORDER BY ${key} DESC LIMIT 1`,
      )
      .get();

    return {
      oldest: oldest?.key ?? null,
      newest: newest?.key ?? null,
      oldestAt: oldest?.at ?? null,
      newestAt: newest?.at ?? null,
    };
  }

  async logPage(query: LogPageQuery) {
    const ascending = query.after !== undefined;
    const clauses = [`l.id${ascending ? ">" : "<"}?`];
    const values: SQLQueryBindings[] = [query.after ?? query.before ?? Number.MAX_SAFE_INTEGER];

    if (query.runId !== undefined) {
      clauses.push("l.run_id=?");
      values.push(query.runId);
    }

    const rows = this.db
      .query<
        LogSummary & { workspace: string; status: RunStatus; textMatches: number },
        SQLQueryBindings[]
      >(
        `SELECT l.id,l.run_id AS runId,r.slug,r.workspace,r.status,l.seq,l.at,l.node_id AS nodeId,l.execution_key AS executionKey,l.attempt,l.level,substr(l.message,1,1024) AS message,l.data_bytes AS dataBytes,instr(lower(l.message),lower(?))>0 AS textMatches FROM logs l JOIN runs r ON r.id=l.run_id WHERE ${clauses.join(" AND ")} ORDER BY l.id ${ascending ? "ASC" : "DESC"} LIMIT ${FEED_SCAN_LIMIT + 1}`,
      )
      .all(query.text ?? "", ...values);

    const bounds = this.feedBounds("logs", "id");

    const page = scanPage({
      candidates: rows,
      limit: Math.min(query.limit, 200),
      key: (row) => row.id,
      matches: (row) =>
        commonMatch(row, query) &&
        (query.level === undefined || row.level === query.level) &&
        (query.executionKey === undefined || row.executionKey === query.executionKey) &&
        (query.text === undefined || row.textMatches === 1),
      ...bounds,
    });

    return {
      ...page,
      ...bounds,
      scannedToAt: page.scanned > 0 ? (rows[page.scanned - 1]?.at ?? null) : null,
      items: page.items.map((row) => ({
        id: row.id,
        runId: row.runId,
        slug: row.slug,
        seq: row.seq,
        at: row.at,
        nodeId: row.nodeId,
        executionKey: row.executionKey,
        attempt: row.attempt,
        level: row.level,
        message: row.message,
        dataBytes: row.dataBytes,
      })),
    };
  }

  async logDetail(id: number) {
    const row = this.db
      .query<{ record: string }, [number]>("SELECT record FROM logs WHERE id=?")
      .get(id);

    return row ? { id, log: rowToLog(row) } : undefined;
  }

  async eventPage(query: EventPageQuery) {
    const ascending = query.after !== undefined;
    const clauses = [`e.sequence${ascending ? ">" : "<"}?`];
    const values: SQLQueryBindings[] = [query.after ?? query.before ?? Number.MAX_SAFE_INTEGER];

    if (query.runId !== undefined) {
      clauses.push("e.run_id=?");
      values.push(query.runId);
    }

    const rows = this.db
      .query<
        EventSummary & { workspace: string | null; status: RunStatus | null },
        SQLQueryBindings[]
      >(
        `SELECT e.sequence,e.at,e.txn,e.run_id AS runId,COALESCE(r.slug,e.slug) AS slug,COALESCE(r.workspace,e.workspace) AS workspace,r.status,e.node_id AS nodeId,e.entity,e.kind FROM events e LEFT JOIN runs r ON r.id=e.run_id WHERE ${clauses.join(" AND ")} ORDER BY e.sequence ${ascending ? "ASC" : "DESC"} LIMIT ${FEED_SCAN_LIMIT + 1}`,
      )
      .all(...values);

    const bounds = this.feedBounds("events", "sequence");

    const page = scanPage({
      candidates: rows,
      limit: Math.min(query.limit, 200),
      key: (row) => row.sequence,
      matches: (row) =>
        commonMatch(row, query) &&
        (query.entity === undefined || row.entity === query.entity) &&
        (query.kind === undefined || row.kind === query.kind) &&
        (query.txn === undefined || row.txn === query.txn),
      ...bounds,
    });

    return {
      ...page,
      ...bounds,
      scannedToAt: page.scanned > 0 ? (rows[page.scanned - 1]?.at ?? null) : null,
      items: page.items.map((row) => ({
        sequence: row.sequence,
        at: row.at,
        txn: row.txn,
        runId: row.runId,
        slug: row.slug,
        nodeId: row.nodeId,
        entity: row.entity,
        kind: row.kind,
      })),
    };
  }

  async eventDetail(sequence: number) {
    const row = this.db
      .query<EventRow, [number]>("SELECT * FROM events WHERE sequence=?")
      .get(sequence);

    return row ? rowToEvent(row) : undefined;
  }
}
