import type { Database } from "bun:sqlite";
import { MAX_PREVIEW_BYTES } from "@loopy/contract";
import type { SqlValue } from "@loopy/runtime/store/portable";
import { FEED_SCAN_LIMIT } from "../../../../../packages/runtime/src/store/query-utils";
import {
  PENDING_HOOK,
  RUN_PREVIEW_COLUMNS,
} from "../../../../../packages/runtime/src/store/sqlite/query/runs";

export function sqlCases(db: Database) {
  const now = new Date().toISOString();

  const runs = db
    .query<{ id: string; slug: string; workspace: string; createdAt: string }, []>(
      "SELECT id,slug,workspace,created_at AS createdAt FROM runs ORDER BY created_at DESC,id DESC LIMIT 200",
    )
    .all();

  const run = runs[0];

  if (!run) {
    throw new Error("Final SQL diagnostics require populated run data.");
  }

  const cases: { name: string; source: string; sql: string; bindings: SqlValue[] }[] = [];

  const add = (name: string, source: string, sql: string, bindings: SqlValue[] = []) =>
    cases.push({ name, source, sql, bindings });

  const runSource = "packages/runtime/src/store/sqlite/query/runs.ts";
  add(
    "runs.latest",
    runSource,
    `SELECT ${RUN_PREVIEW_COLUMNS} FROM runs r  ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
    [50],
  );
  add(
    "runs.slug-workspace",
    runSource,
    `SELECT ${RUN_PREVIEW_COLUMNS} FROM runs r WHERE r.slug=? AND r.workspace=? ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
    [run.slug, run.workspace, 50],
  );
  add(
    "runs.failed",
    runSource,
    `SELECT ${RUN_PREVIEW_COLUMNS} FROM runs r WHERE r.status=? ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
    ["failed", 50],
  );
  add(
    "runs.page2",
    runSource,
    `SELECT ${RUN_PREVIEW_COLUMNS} FROM runs r WHERE (r.created_at,r.id)<(?,?) ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
    [runs[49]?.createdAt ?? run.createdAt, runs[49]?.id ?? run.id, 50],
  );
  add(
    "runs.waiting",
    runSource,
    `SELECT ${RUN_PREVIEW_COLUMNS} FROM runs r WHERE EXISTS(${PENDING_HOOK}) ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
    [now, 50],
  );
  add("counts.all", runSource, "SELECT status,count(*) AS count FROM runs r  GROUP BY status");
  add(
    "counts.slug-workspace",
    runSource,
    "SELECT status,count(*) AS count FROM runs r WHERE r.slug=? AND r.workspace=? GROUP BY status",
    [run.slug, run.workspace],
  );

  for (const count of [50, 99, 100, 200]) {
    const ids = runs.slice(0, count).map((value) => value.id);
    const projection = `SELECT r.id,(${PENDING_HOOK.replace("SELECT w.record", "SELECT json_set(w.record,'$.expiresAt',json_extract(n.record,'$.wakeAt'))")}) AS record FROM runs r WHERE r.id IN `;
    add(
      `pending-hooks.historical-in-${count}`,
      `${runSource}:historical-pre-fix-exact-shape`,
      `${projection}(${ids.map(() => "?").join(",")})`,
      [now, ...ids],
    );
    add(
      `pending-hooks.current-json-each-${count}`,
      `${runSource}:current-post-fix-exact-shape`,
      `${projection}(SELECT value FROM json_each(?))`,
      [now, JSON.stringify(ids)],
    );
  }

  const feedSource = "packages/runtime/src/store/sqlite/query/feeds.ts";

  const logProjection =
    "l.id,l.run_id AS runId,r.slug,r.workspace,r.status,l.seq,l.at,l.node_id AS nodeId,l.execution_key AS executionKey,l.attempt,l.level,substr(l.message,1,1024) AS message,l.data_bytes AS dataBytes,instr(lower(l.message),lower(?))>0 AS textMatches";

  const eventProjection =
    "e.sequence,e.at,e.txn,e.run_id AS runId,COALESCE(r.slug,e.slug) AS slug,COALESCE(r.workspace,e.workspace) AS workspace,r.status,e.node_id AS nodeId,e.entity,e.kind";

  add(
    "logs.candidates",
    feedSource,
    `SELECT ${logProjection} FROM logs l JOIN runs r ON r.id=l.run_id WHERE l.id<? ORDER BY l.id DESC LIMIT ${FEED_SCAN_LIMIT + 1}`,
    ["", Number.MAX_SAFE_INTEGER],
  );
  add(
    "logs.text-candidates",
    feedSource,
    `SELECT ${logProjection} FROM logs l JOIN runs r ON r.id=l.run_id WHERE l.id<? ORDER BY l.id DESC LIMIT ${FEED_SCAN_LIMIT + 1}`,
    ["playground", Number.MAX_SAFE_INTEGER],
  );
  add(
    "logs.run-candidates",
    feedSource,
    `SELECT ${logProjection} FROM logs l JOIN runs r ON r.id=l.run_id WHERE l.id<? AND l.run_id=? ORDER BY l.id DESC LIMIT ${FEED_SCAN_LIMIT + 1}`,
    ["", Number.MAX_SAFE_INTEGER, run.id],
  );
  add(
    "events.candidates",
    feedSource,
    `SELECT ${eventProjection} FROM events e LEFT JOIN runs r ON r.id=e.run_id WHERE e.sequence<? ORDER BY e.sequence DESC LIMIT ${FEED_SCAN_LIMIT + 1}`,
    [Number.MAX_SAFE_INTEGER],
  );
  add(
    "events.run-candidates",
    feedSource,
    `SELECT ${eventProjection} FROM events e LEFT JOIN runs r ON r.id=e.run_id WHERE e.sequence<? AND e.run_id=? ORDER BY e.sequence DESC LIMIT ${FEED_SCAN_LIMIT + 1}`,
    [Number.MAX_SAFE_INTEGER, run.id],
  );
  const nodeSource = "packages/runtime/src/store/sqlite/query/nodes.ts";
  add(
    "executions.page",
    nodeSource,
    `SELECT execution_key,CASE WHEN status='succeeded' AND length(CAST(output AS BLOB))>${MAX_PREVIEW_BYTES} THEN json_remove(json_set(record,'$.output',NULL),'$.inputView') ELSE json_remove(record,'$.inputView') END AS record,CASE WHEN status='succeeded' THEN length(CAST(output AS BLOB)) ELSE 0 END AS bytes FROM node_runs WHERE run_id=? AND scope=? ORDER BY execution_key LIMIT ?`,
    [run.id, "[]", 51],
  );

  const key = db
    .query<{ key: string }, [string]>(
      "SELECT execution_key AS key FROM node_runs WHERE run_id=? ORDER BY execution_key LIMIT 1",
    )
    .get(run.id)?.key;

  if (key) {
    add(
      "execution.attempts",
      nodeSource,
      `SELECT attempt,length(CAST(record->'$.output' AS BLOB)) AS bytes,CASE WHEN json_type(record,'$.output') IS NOT NULL AND length(CAST(record->'$.output' AS BLOB))>${MAX_PREVIEW_BYTES} THEN json_set(record,'$.output',NULL) ELSE record END AS record FROM node_attempts WHERE run_id=? AND execution_key=? AND attempt>? ORDER BY attempt LIMIT 201`,
      [run.id, key, 0],
    );
  }

  const scheduler = "apps/cloud/src/scheduler.ts";
  add(
    "scheduler.running",
    scheduler,
    `SELECT r.id,t.cursor,r.owner_token,r.heartbeat_at
      FROM runs r LEFT JOIN cloud_turns t ON r.id=t.run_id WHERE r.status='running'
      AND (t.next_at IS NULL OR t.next_at<=?) ORDER BY r.created_at,r.id LIMIT ?`,
    [now, 4],
  );
  add(
    "scheduler.ready",
    scheduler,
    `SELECT r.id,t.cursor,r.owner_token,r.heartbeat_at
      FROM runs r LEFT JOIN cloud_turns t ON r.id=t.run_id
      WHERE r.owner_token IS NULL AND (r.status='queued' OR (r.status='suspended' AND r.wake_at<=?))
      AND (t.error IS NULL OR t.next_at<=?)
      ORDER BY r.created_at,r.id LIMIT ?`,
    [now, now, 4],
  );

  return cases;
}
