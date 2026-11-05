import { Schema } from "effect";
import {
  type HookRecord,
  type OverviewQuery,
  type RunDefinitionCount,
  type RunFilter,
  type RunPageQuery,
  type RunRecord,
  type StatusCounts,
} from "../../core/index.js";
import { storageOperation } from "../operation.js";
import { overviewBuckets, PREVIEW_BYTES } from "../query-utils.js";
import { storedDecoder } from "../row-codec.js";
import { waitRecordSchema } from "../wait-schema.js";
import type { SqlValue } from "./driver.js";
import { SqliteSchedules } from "./schedules.js";
import { rowToRun } from "./store-rows.js";
import type { RunRow } from "./store-schema.js";

export const PENDING_HOOK = `SELECT w.record FROM waits w JOIN node_runs n ON n.run_id=w.run_id AND n.execution_key=w.execution_key
  WHERE w.run_id=r.id AND r.status IN ('running','suspended') AND n.status='waiting'
  AND json_extract(w.record,'$.resolvedAt') IS NULL AND json_extract(w.record,'$.expiredAt') IS NULL
  AND (json_extract(n.record,'$.wakeAt') IS NULL OR json_extract(n.record,'$.wakeAt')>?) LIMIT 1`;

export function runWhere(filter: RunFilter, alias = "r") {
  const clauses: string[] = [];
  const values: SqlValue[] = [];

  for (const [field, value] of [
    ["slug", filter.slug],
    ["workspace", filter.workspace],
    ["status", filter.status],
  ] as const) {
    if (value !== undefined) {
      clauses.push(`${alias}.${field}=?`);
      values.push(value);
    }
  }

  if (filter.from !== undefined) {
    clauses.push(`${alias}.created_at>=?`);
    values.push(filter.from);
  }

  if (filter.to !== undefined) {
    clauses.push(`${alias}.created_at<?`);
    values.push(filter.to);
  }

  return { clauses, values };
}

export const RUN_PREVIEW_COLUMNS = `r.id,r.slug,r.revision,r.workspace,r.status,r.error,r.wake_at,r.next_retry_at,r.created_at,r.updated_at,r.owner_token,r.owner_pid,r.owner_host,r.heartbeat_at,
 CASE WHEN length(CAST(r.input_json AS BLOB))>${PREVIEW_BYTES} THEN 'null' ELSE r.input_json END AS input_json,
 CASE WHEN length(CAST(r.output_json AS BLOB))>${PREVIEW_BYTES} THEN 'null' ELSE r.output_json END AS output_json,
 length(CAST(r.input_json AS BLOB)) AS input_bytes,length(CAST(r.output_json AS BLOB)) AS output_bytes`;

export type PreviewRunRow = RunRow & { input_bytes: number; output_bytes: number | null };

export function previewRun(row: PreviewRunRow) {
  const run = rowToRun(row);

  const truncatedFields: NonNullable<RunRecord["truncatedFields"]> = {};

  if (row.input_bytes > PREVIEW_BYTES) {
    truncatedFields.input = row.input_bytes;
  }

  if (row.output_bytes !== null && row.output_bytes > PREVIEW_BYTES) {
    truncatedFields.output = row.output_bytes;
  }

  if (Object.keys(truncatedFields).length > 0) {
    run.truncatedFields = truncatedFields;
  }

  return run;
}

const pendingHookSchema = Schema.Struct({
  ...waitRecordSchema.fields,
  expiresAt: Schema.NullOr(Schema.String),
});

const decodePendingHook = storedDecoder(pendingHookSchema, "waits");

export class SqliteQueryRuns extends SqliteSchedules {
  runReference(id: string) {
    return storageOperation("runReference", () => {
      return (
        this.db
          .query<Pick<RunRecord, "id" | "slug" | "workspace" | "revision">, [string]>(
            "SELECT id,slug,workspace,revision FROM runs WHERE id=?",
          )
          .get(id) ?? undefined
      );
    });
  }
  queryRuns(query: RunPageQuery) {
    return storageOperation("queryRuns", () => {
      const { clauses, values } = runWhere(query);

      if (query.before !== undefined) {
        const separator = query.before.indexOf("|");
        clauses.push("(r.created_at,r.id)<(?,?)");
        values.push(query.before.slice(0, separator), query.before.slice(separator + 1));
      }

      if (query.waiting !== undefined) {
        clauses.push(`${query.waiting ? "" : "NOT "}EXISTS(${PENDING_HOOK})`);
        values.push(query.now);
      }

      return this.db
        .query<PreviewRunRow, SqlValue[]>(
          `SELECT ${RUN_PREVIEW_COLUMNS} FROM runs r ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
        )
        .all(...values, Math.min(query.limit, 200))
        .map(previewRun);
    });
  }

  runningCount() {
    return storageOperation("runningCount", () => {
      return (
        this.db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM runs WHERE status='running'")
          .get()?.count ?? 0
      );
    });
  }

  runCountsByDefinition() {
    return storageOperation("runCountsByDefinition", () => {
      return this.db
        .query<RunDefinitionCount, []>(
          "SELECT workspace,slug,status,count(*) AS count FROM runs GROUP BY workspace,slug,status",
        )
        .all();
    });
  }

  runWorkspaces() {
    return storageOperation("runWorkspaces", () => {
      return this.db
        .query<{ workspace: string }, []>("SELECT DISTINCT workspace FROM runs")
        .all()
        .map((row) => row.workspace);
    });
  }

  pendingHooks(ids: string[], now: string) {
    return storageOperation("pendingHooks", () => {
      const hooks = new Map<string, HookRecord & { expiresAt: string | null }>();

      if (ids.length === 0) {
        return hooks;
      }

      // One array binding keeps a 200-run page below workerd's SQL variable limit.
      const rows = this.db
        .query<{ id: string; record: string | null }, SqlValue[]>(
          `SELECT r.id,(${PENDING_HOOK.replace("SELECT w.record", "SELECT json_set(w.record,'$.expiresAt',json_extract(n.record,'$.wakeAt'))")}) AS record FROM runs r WHERE r.id IN (SELECT value FROM json_each(?))`,
        )
        .all(now, JSON.stringify(ids));

      for (const row of rows) {
        if (row.record === null) {
          continue;
        }

        const hook = decodePendingHook(row.record);

        hooks.set(row.id, hook);
      }

      return hooks;
    });
  }

  overview(query: OverviewQuery) {
    return storageOperation("overview", () => {
      const overview = overviewBuckets(query);
      const { clauses, values } = runWhere(query);

      const rows = this.db
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
    });
  }
}
