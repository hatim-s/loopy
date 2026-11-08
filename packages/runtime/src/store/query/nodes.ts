import {
  executionKeySchema,
  type NodePageQuery,
  type ScopeCountsView,
  type ScopeItemsPage,
  type ScopeItemsQuery,
} from "@loopy/contract";
import { MAX_PREVIEW_BYTES, type NodeRunStatus, PAGE_LIMIT } from "@loopy/core";
import type { SqlContext } from "../context";
import type { SqlValue } from "../driver";
import { readEventCursor } from "../events";
import { readNode } from "../nodes";
import { storedDecoder } from "../row-codec";
import { decodeNodeRun } from "../rows";
import { readHooks } from "../waits";
import { type PreviewRunRow, previewRun, RUN_PREVIEW_COLUMNS } from "./runs";

const decodeScope = storedDecoder(executionKeySchema.fields.scope, "query-nodes");

// Exported with the other store projections so read-only diagnostics run the exact query shape.
export const NODE_PAGE_PROJECTION = `execution_key,CASE WHEN status='succeeded' AND length(CAST(output AS BLOB))>${MAX_PREVIEW_BYTES} THEN json_remove(json_set(record,'$.output',NULL),'$.inputView') ELSE json_remove(record,'$.inputView') END AS record,CASE WHEN status='succeeded' THEN length(CAST(output AS BLOB)) ELSE 0 END AS bytes`;

export const ATTEMPT_PROJECTION = `attempt,length(CAST(record->'$.output' AS BLOB)) AS bytes,CASE WHEN json_type(record,'$.output') IS NOT NULL AND length(CAST(record->'$.output' AS BLOB))>${MAX_PREVIEW_BYTES} THEN json_set(record,'$.output',NULL) ELSE record END AS record`;

export function readNodePage(ctx: SqlContext, runId: string, query: NodePageQuery) {
  const clauses = ["run_id=?", "scope=?"];
  const values: SqlValue[] = [runId, query.scope];

  if (query.nodeId !== undefined) {
    clauses.push("node_id=?");
    values.push(query.nodeId);
  }

  if (query.status !== undefined) {
    clauses.push("status=?");
    values.push(query.status);
  }

  if (query.after !== undefined) {
    clauses.push("execution_key>?");
    values.push(query.after);
  }

  const rows = ctx.db
    .query<{ record: string; bytes: number; execution_key: string }, SqlValue[]>(
      `SELECT ${NODE_PAGE_PROJECTION} FROM node_runs WHERE ${clauses.join(" AND ")} ORDER BY execution_key LIMIT ?`,
    )
    .all(...values, query.limit + 1);

  const selected = rows.slice(0, query.limit);
  const truncatedOutputs: Record<string, number> = {};

  for (const row of selected) {
    if (row.bytes > MAX_PREVIEW_BYTES) {
      truncatedOutputs[row.execution_key] = row.bytes;
    }
  }

  return {
    items: selected.map((row) => decodeNodeRun(row.record)),
    next: rows.length > query.limit ? (selected.at(-1)?.execution_key ?? null) : null,
    truncatedOutputs,
  };
}

export function readScopeCounts(
  ctx: SqlContext,
  runId: string,
  parentScope: string,
): ScopeCountsView[] {
  const rows = ctx.db
    .query<
      { map_node: string; status: NodeRunStatus; count: number; total: number },
      [string, string, number]
    >(
      `WITH maps AS (SELECT map_node,count(DISTINCT item_index) AS total FROM node_scopes WHERE run_id=?1 AND parent_scope=?2 GROUP BY map_node ORDER BY map_node LIMIT ?3) SELECT m.map_node,m.total,s.status,count(*) AS count FROM maps m JOIN node_scopes s ON s.run_id=?1 AND s.parent_scope=?2 AND s.map_node=m.map_node GROUP BY m.map_node,s.status`,
    )
    .all(runId, parentScope, PAGE_LIMIT);

  const summaries = new Map<string, ScopeCountsView>();

  for (const row of rows) {
    const summary = summaries.get(row.map_node) ?? {
      nodeId: row.map_node,
      parentScope: decodeScope(parentScope),
      total: row.total,
      totalKind: "materialized" as const,
      counts: {},
    };

    summary.counts[row.status] = row.count;
    summaries.set(row.map_node, summary);
  }

  return [...summaries.values()];
}

export function readScopeItems(
  ctx: SqlContext,
  runId: string,
  query: ScopeItemsQuery,
): ScopeItemsPage {
  const values: SqlValue[] = [runId, query.nodeId, query.parentScope, query.after ?? -1];
  const status = query.status === undefined ? "" : " AND status=?";

  if (query.status !== undefined) {
    values.push(query.status);
  }

  const indices = ctx.db
    .query<{ item_index: number }, SqlValue[]>(
      `SELECT DISTINCT item_index FROM node_scopes WHERE run_id=? AND map_node=? AND parent_scope=? AND item_index>?${status} ORDER BY item_index LIMIT ?`,
    )
    .all(...values, query.limit + 1);

  const selected = indices.slice(0, query.limit);

  if (selected.length === 0) {
    return { items: [], next: null };
  }

  const rows = ctx.db
    .query<{ item_index: number; status: NodeRunStatus; count: number }, SqlValue[]>(
      `SELECT item_index,status,count(*) AS count FROM node_scopes WHERE run_id=? AND map_node=? AND parent_scope=? AND item_index IN (SELECT value FROM json_each(?)) GROUP BY item_index,status ORDER BY item_index`,
    )
    .all(
      runId,
      query.nodeId,
      query.parentScope,
      JSON.stringify(selected.map((row) => row.item_index)),
    );

  const items = new Map<number, ScopeItemsPage["items"][number]>();

  for (const row of rows) {
    const item = items.get(row.item_index) ?? { index: row.item_index, counts: {} };
    item.counts[row.status] = row.count;
    items.set(row.item_index, item);
  }

  return {
    items: [...items.values()],
    next: indices.length > query.limit ? (selected.at(-1)?.item_index ?? null) : null,
  };
}

export function readDashboardSnapshot(ctx: SqlContext, id: string) {
  const row = ctx.db
    .query<PreviewRunRow, [string]>(`SELECT ${RUN_PREVIEW_COLUMNS} FROM runs r WHERE r.id=?`)
    .get(id);

  if (!row) {
    return undefined;
  }

  const nodes = readNodePage(ctx, id, { scope: "[]", limit: PAGE_LIMIT });
  const hooks = readHooks(ctx, id, PAGE_LIMIT + 1);

  return {
    run: previewRun(row),
    nodeRuns: nodes.items,
    nodeRunsNext: nodes.next,
    truncatedOutputs: nodes.truncatedOutputs,
    scopes: readScopeCounts(ctx, id, "[]"),
    logs: [],
    hooks: hooks.slice(0, PAGE_LIMIT),
    hooksTruncated: hooks.length > PAGE_LIMIT,
    ...readEventCursor(ctx),
  };
}

export function readExecution(ctx: SqlContext, runId: string, key: string, after: number) {
  const node = readNode(ctx, runId, key);

  if (!node) {
    return undefined;
  }

  const rows = ctx.db
    .query<
      { record: string; attempt: number; bytes: number | null },
      [string, string, number, number]
    >(
      `SELECT ${ATTEMPT_PROJECTION} FROM node_attempts WHERE run_id=? AND execution_key=? AND attempt>? ORDER BY attempt LIMIT ?`,
    )
    .all(runId, key, after, PAGE_LIMIT + 1);

  const selected = rows.slice(0, PAGE_LIMIT);
  const attempts = selected.map((row) => decodeNodeRun(row.record));
  const truncatedAttempts: Record<string, number> = {};

  for (const row of selected) {
    if (row.bytes !== null && row.bytes > MAX_PREVIEW_BYTES) {
      truncatedAttempts[String(row.attempt)] = row.bytes;
    }
  }

  return {
    node,
    attempts,
    truncatedAttempts,
    attemptsNext: rows.length > PAGE_LIMIT ? (attempts.at(-1)?.attempt ?? null) : null,
  };
}
