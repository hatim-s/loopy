import type { Database } from "bun:sqlite";
import type { SqlValue } from "@loopy/runtime/store/portable";
import {
  EVENT_PROJECTION,
  LOG_PROJECTION,
} from "../../../../../packages/runtime/src/store/query/feeds";
import {
  ATTEMPT_PROJECTION,
  NODE_PAGE_PROJECTION,
} from "../../../../../packages/runtime/src/store/query/nodes";
import {
  PENDING_HOOK_PROJECTION,
  pendingHook,
  RUN_PREVIEW_COLUMNS,
} from "../../../../../packages/runtime/src/store/query/runs";
import { FEED_SCAN_LIMIT } from "../../../../../packages/runtime/src/store/query/scan";
import { READY_TURNS, RUNNING_TURNS } from "../../../../../packages/runtime/src/store/turns";

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

  const runSource = "packages/runtime/src/store/query/runs.ts";
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
    `SELECT ${RUN_PREVIEW_COLUMNS} FROM runs r WHERE EXISTS(${pendingHook("1")}) ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
    [now, 50],
  );
  add("counts.all", runSource, "SELECT status,count(*) AS count FROM runs r  GROUP BY status");
  add(
    "counts.slug-workspace",
    runSource,
    "SELECT status,count(*) AS count FROM runs r WHERE r.slug=? AND r.workspace=? GROUP BY status",
    [run.slug, run.workspace],
  );

  const projection = `${PENDING_HOOK_PROJECTION} WHERE r.id IN (SELECT value FROM json_each(?))`;

  for (const count of [50, 100, 200]) {
    const ids = runs.slice(0, count).map((value) => value.id);
    add(`pending-hooks.json-each-${count}`, runSource, projection, [now, JSON.stringify(ids)]);
  }

  const feedSource = "packages/runtime/src/store/query/feeds.ts";

  add(
    "logs.candidates",
    feedSource,
    `SELECT ${LOG_PROJECTION} FROM logs l JOIN runs r ON r.id=l.run_id WHERE l.id<? ORDER BY l.id DESC LIMIT ${FEED_SCAN_LIMIT + 1}`,
    ["", Number.MAX_SAFE_INTEGER],
  );
  add(
    "logs.text-candidates",
    feedSource,
    `SELECT ${LOG_PROJECTION} FROM logs l JOIN runs r ON r.id=l.run_id WHERE l.id<? ORDER BY l.id DESC LIMIT ${FEED_SCAN_LIMIT + 1}`,
    ["playground", Number.MAX_SAFE_INTEGER],
  );
  add(
    "logs.run-candidates",
    feedSource,
    `SELECT ${LOG_PROJECTION} FROM logs l JOIN runs r ON r.id=l.run_id WHERE l.id<? AND l.run_id=? ORDER BY l.id DESC LIMIT ${FEED_SCAN_LIMIT + 1}`,
    ["", Number.MAX_SAFE_INTEGER, run.id],
  );
  add(
    "events.candidates",
    feedSource,
    `SELECT ${EVENT_PROJECTION} FROM events e LEFT JOIN runs r ON r.id=e.run_id WHERE e.sequence<? ORDER BY e.sequence DESC LIMIT ${FEED_SCAN_LIMIT + 1}`,
    [Number.MAX_SAFE_INTEGER],
  );
  add(
    "events.run-candidates",
    feedSource,
    `SELECT ${EVENT_PROJECTION} FROM events e LEFT JOIN runs r ON r.id=e.run_id WHERE e.sequence<? AND e.run_id=? ORDER BY e.sequence DESC LIMIT ${FEED_SCAN_LIMIT + 1}`,
    [Number.MAX_SAFE_INTEGER, run.id],
  );
  const nodeSource = "packages/runtime/src/store/query/nodes.ts";
  add(
    "executions.page",
    nodeSource,
    `SELECT ${NODE_PAGE_PROJECTION} FROM node_runs WHERE run_id=? AND scope=? ORDER BY execution_key LIMIT ?`,
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
      `SELECT ${ATTEMPT_PROJECTION} FROM node_attempts WHERE run_id=? AND execution_key=? AND attempt>? ORDER BY attempt LIMIT 201`,
      [run.id, key, 0],
    );
  }

  const turns = "packages/runtime/src/store/turns.ts";
  add("scheduler.running", turns, RUNNING_TURNS, [now, 4]);
  add("scheduler.ready", turns, READY_TURNS, [now, now, 4]);

  return cases;
}
