import type {
  EventHistoryPage,
  EventPageQuery,
  EventSummaryView,
  GlobalLogsPage,
  LogPageQuery,
  LogSummaryView,
} from "@loopy/contract";
import type { RunStatus } from "@loopy/core";
import { FEED_SCAN_LIMIT, scanPage } from "../../query-utils";
import type { SqlContext } from "../context";
import type { SqlValue } from "../driver";

type FeedRow = {
  runId: string | null;
  slug: string | null;
  workspace: string | null;
  status: RunStatus | null;
  at: string;
  nodeId: string | null;
};

function commonMatch(row: FeedRow, query: LogPageQuery | EventPageQuery) {
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

function feedBounds(ctx: SqlContext, table: "logs" | "events", key: "id" | "sequence") {
  const bound = (order: "ASC" | "DESC") =>
    ctx.db
      .query<{ key: number; at: string }, []>(
        `SELECT ${key} AS key,at FROM ${table} ORDER BY ${key} ${order} LIMIT 1`,
      )
      .get();

  const oldest = bound("ASC");
  const newest = bound("DESC");

  return {
    oldest: oldest?.key ?? null,
    newest: newest?.key ?? null,
    oldestAt: oldest?.at ?? null,
    newestAt: newest?.at ?? null,
  };
}

function feedCursor(query: LogPageQuery | EventPageQuery, column: string) {
  const ascending = query.after !== undefined;
  const clauses = [`${column}${ascending ? ">" : "<"}?`];
  const values: SqlValue[] = [query.after ?? query.before ?? Number.MAX_SAFE_INTEGER];

  return { ascending, clauses, values };
}

// Exported with the other store projections so read-only diagnostics run the exact query shape.
export const LOG_PROJECTION =
  "l.id,l.run_id AS runId,r.slug,r.workspace,r.status,l.seq,l.at,l.node_id AS nodeId,l.execution_key AS executionKey,l.attempt,l.level,substr(l.message,1,1024) AS message,l.data_bytes AS dataBytes,instr(lower(l.message),lower(?))>0 AS textMatches";

export const EVENT_PROJECTION =
  "e.sequence,e.at,e.txn,e.run_id AS runId,COALESCE(r.slug,e.slug) AS slug,COALESCE(r.workspace,e.workspace) AS workspace,r.status,e.node_id AS nodeId,e.entity,e.kind";

export function readLogPage(ctx: SqlContext, query: LogPageQuery): GlobalLogsPage {
  const { ascending, clauses, values } = feedCursor(query, "l.id");

  if (query.runId !== undefined) {
    clauses.push("l.run_id=?");
    values.push(query.runId);
  }

  const rows = ctx.db
    .query<LogSummaryView & FeedRow & { textMatches: number }, SqlValue[]>(
      `SELECT ${LOG_PROJECTION} FROM logs l JOIN runs r ON r.id=l.run_id WHERE ${clauses.join(" AND ")} ORDER BY l.id ${ascending ? "ASC" : "DESC"} LIMIT ${FEED_SCAN_LIMIT + 1}`,
    )
    .all(query.text ?? "", ...values);

  const bounds = feedBounds(ctx, "logs", "id");

  const page = scanPage({
    candidates: rows,
    limit: query.limit,
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

export function readEventPage(ctx: SqlContext, query: EventPageQuery): EventHistoryPage {
  const { ascending, clauses, values } = feedCursor(query, "e.sequence");

  if (query.runId !== undefined) {
    clauses.push("e.run_id=?");
    values.push(query.runId);
  }

  const rows = ctx.db
    .query<EventSummaryView & FeedRow, SqlValue[]>(
      `SELECT ${EVENT_PROJECTION} FROM events e LEFT JOIN runs r ON r.id=e.run_id WHERE ${clauses.join(" AND ")} ORDER BY e.sequence ${ascending ? "ASC" : "DESC"} LIMIT ${FEED_SCAN_LIMIT + 1}`,
    )
    .all(...values);

  const bounds = feedBounds(ctx, "events", "sequence");

  const page = scanPage({
    candidates: rows,
    limit: query.limit,
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
