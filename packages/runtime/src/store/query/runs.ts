import {
  decodeRunCursor,
  type OverviewQuery,
  type PendingHook,
  type RunDefinitionCount,
  type RunPageQuery,
  type RunPreview,
  type StatusCounts,
} from "@loopy/contract";
import { MAX_PREVIEW_BYTES, type RunRecord, waitRecordSchema } from "@loopy/core";
import { Schema } from "effect";
import type { SqlContext } from "../context";
import type { SqlValue } from "../driver";
import { storedDecoder } from "../row-codec";
import { type RunRow, rowToRun } from "../rows";
import { overviewBuckets } from "./scan";

type RunFilter = Pick<RunPageQuery, "slug" | "workspace" | "status" | "from" | "to">;

/**
 * Selects `column` from the first pending wait of run `r`, binding the current time once. It
 * mirrors core's isPendingWait, so a run lists as waiting exactly when a signal would be accepted.
 */
export const pendingHook = (column: string) => `SELECT ${column} FROM waits w
  JOIN node_runs n ON n.run_id=w.run_id AND n.execution_key=w.execution_key
  WHERE w.run_id=r.id AND r.status NOT IN ('succeeded','failed','cancelled') AND n.status='waiting'
  AND json_extract(w.record,'$.resolvedAt') IS NULL AND json_extract(w.record,'$.expiredAt') IS NULL
  AND (json_extract(n.record,'$.wakeAt') IS NULL OR json_extract(n.record,'$.wakeAt')>?) LIMIT 1`;

/** Each run's id with its first pending wait and that wait's deadline as `expiresAt`, or null. */
export const PENDING_HOOK_PROJECTION = `SELECT r.id,(${pendingHook(
  "json_set(w.record,'$.expiresAt',json_extract(n.record,'$.wakeAt'))",
)}) AS record FROM runs r`;

function runWhere(filter: RunFilter) {
  const clauses: string[] = [];
  const values: SqlValue[] = [];

  for (const [field, value] of [
    ["slug", filter.slug],
    ["workspace", filter.workspace],
    ["status", filter.status],
  ] as const) {
    if (value !== undefined) {
      clauses.push(`r.${field}=?`);
      values.push(value);
    }
  }

  if (filter.from !== undefined) {
    clauses.push("r.created_at>=?");
    values.push(filter.from);
  }

  if (filter.to !== undefined) {
    clauses.push("r.created_at<?");
    values.push(filter.to);
  }

  return { clauses, values };
}

export const RUN_PREVIEW_COLUMNS = `r.id,r.slug,r.revision,r.workspace,r.status,r.error,r.wake_at,r.created_at,r.updated_at,r.owner_token,r.owner_pid,r.owner_host,r.heartbeat_at,
 CASE WHEN length(CAST(r.input_json AS BLOB))>${MAX_PREVIEW_BYTES} THEN 'null' ELSE r.input_json END AS input_json,
 CASE WHEN length(CAST(r.output_json AS BLOB))>${MAX_PREVIEW_BYTES} THEN 'null' ELSE r.output_json END AS output_json,
 length(CAST(r.input_json AS BLOB)) AS input_bytes,length(CAST(r.output_json AS BLOB)) AS output_bytes`;

export type PreviewRunRow = RunRow & { input_bytes: number; output_bytes: number | null };

export function previewRun(row: PreviewRunRow): RunPreview {
  const run: RunPreview = rowToRun(row);

  const truncatedFields: NonNullable<RunPreview["truncatedFields"]> = {};

  if (row.input_bytes > MAX_PREVIEW_BYTES) {
    truncatedFields.input = row.input_bytes;
  }

  if (row.output_bytes !== null && row.output_bytes > MAX_PREVIEW_BYTES) {
    truncatedFields.output = row.output_bytes;
  }

  if (Object.keys(truncatedFields).length > 0) {
    run.truncatedFields = truncatedFields;
  }

  return run;
}

const decodePendingHook = storedDecoder(
  Schema.Struct({ ...waitRecordSchema.fields, expiresAt: Schema.NullOr(Schema.String) }),
  "waits",
);

export function readRunReference(ctx: SqlContext, id: string) {
  return (
    ctx.db
      .query<Pick<RunRecord, "id" | "slug" | "workspace" | "revision">, [string]>(
        "SELECT id,slug,workspace,revision FROM runs WHERE id=?",
      )
      .get(id) ?? undefined
  );
}

export function queryRuns(ctx: SqlContext, query: RunPageQuery): RunPreview[] {
  const { clauses, values } = runWhere(query);

  if (query.before !== undefined) {
    const cursor = decodeRunCursor(query.before);
    clauses.push("(r.created_at,r.id)<(?,?)");
    values.push(cursor.createdAt, cursor.id);
  }

  if (query.waiting !== undefined) {
    clauses.push(`${query.waiting ? "" : "NOT "}EXISTS(${pendingHook("1")})`);
    values.push(query.now);
  }

  return ctx.db
    .query<PreviewRunRow, SqlValue[]>(
      `SELECT ${RUN_PREVIEW_COLUMNS} FROM runs r ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
    )
    .all(...values, query.limit)
    .map(previewRun);
}

export function readRunCountsByDefinition(ctx: SqlContext) {
  return ctx.db
    .query<RunDefinitionCount, []>(
      "SELECT workspace,slug,status,count(*) AS count FROM runs GROUP BY workspace,slug,status",
    )
    .all();
}

export function readRunWorkspaces(ctx: SqlContext): string[] {
  return ctx.db
    .query<{ workspace: string }, []>("SELECT DISTINCT workspace FROM runs")
    .all()
    .map((row) => row.workspace);
}

export function readPendingHooks(ctx: SqlContext, ids: string[], now: string) {
  const hooks = new Map<string, PendingHook>();

  if (ids.length === 0) {
    return hooks;
  }

  // One array binding keeps a full run page below workerd's SQL variable limit.
  const rows = ctx.db
    .query<{ id: string; record: string | null }, SqlValue[]>(
      `${PENDING_HOOK_PROJECTION} WHERE r.id IN (SELECT value FROM json_each(?))`,
    )
    .all(now, JSON.stringify(ids));

  for (const row of rows) {
    if (row.record !== null) {
      hooks.set(row.id, decodePendingHook(row.record));
    }
  }

  return hooks;
}

export function readOverview(ctx: SqlContext, query: OverviewQuery) {
  const overview = overviewBuckets(query);
  const { clauses, values } = runWhere(query);

  const rows = ctx.db
    .query<{ bucket: number; status: keyof StatusCounts; count: number }, SqlValue[]>(
      `SELECT CAST((unixepoch(created_at,'subsec')-?)/? AS INTEGER) AS bucket,status,count(*) AS count FROM runs r WHERE ${clauses.join(" AND ")} GROUP BY bucket,status`,
    )
    .all(Date.parse(query.from) / 1000, query.bucketSeconds, ...values);

  for (const row of rows) {
    const bucket = overview.buckets[row.bucket];

    if (bucket) {
      bucket.counts[row.status] = row.count;
      overview.counts[row.status] += row.count;
    }
  }

  return overview;
}
