import type { Database } from "bun:sqlite";
import { encodeRunCursor } from "@loopy/contract";
import type { SqlDriver, SqlStatement, SqlValue } from "@loopy/runtime/store/portable";
import type { SqlContext } from "../../../../../packages/runtime/src/store/context";
import { readEventPage, readLogPage } from "../../../../../packages/runtime/src/store/query/feeds";
import { readExecution, readNodePage } from "../../../../../packages/runtime/src/store/query/nodes";
import {
  queryRuns,
  readPendingHooks,
  readRunCountsByDefinition,
} from "../../../../../packages/runtime/src/store/query/runs";
import { readDueTurns } from "../../../../../packages/runtime/src/store/turns";

type Statement = { sql: string; bindings: SqlValue[] };

/** Runs reads against the copy and records each statement exactly as the store sent it. */
class RecordingDriver implements SqlDriver {
  readonly statements: Statement[] = [];

  constructor(private readonly db: Database) {}

  query<Row = Record<string, SqlValue>, Params extends SqlValue[] = SqlValue[]>(
    sql: string,
  ): SqlStatement<Row, Params> {
    const statement = this.db.query<Row, SqlValue[]>(sql);

    return {
      get: (...params) => {
        this.statements.push({ sql, bindings: params });

        return statement.get(...params);
      },
      all: (...params) => {
        this.statements.push({ sql, bindings: params });

        return statement.all(...params);
      },
      run: () => {
        throw new Error("The SQL probe is read-only. A store write reached it.");
      },
    };
  }

  exec(): void {
    throw new Error("The SQL probe is read-only. A store write reached it.");
  }

  transaction<T>(callback: () => T): T {
    return callback();
  }
}

// Each read runs only for the statements it records, so its result is discarded.
type Operation = [name: string, source: keyof typeof SOURCES, read: () => void];

const SOURCES = {
  runs: "packages/runtime/src/store/query/runs.ts",
  feeds: "packages/runtime/src/store/query/feeds.ts",
  nodes: "packages/runtime/src/store/query/nodes.ts",
  turns: "packages/runtime/src/store/turns.ts",
} as const;

/**
 * Each case is one store read function called on the diagnostic copy. A read that sends several
 * statements yields one case per statement, named `<operation>#<n>` after the first.
 */
export function sqlCases(db: Database) {
  const now = new Date().toISOString();
  const driver = new RecordingDriver(db);

  const ctx: SqlContext = {
    db: driver,
    owner: { identity: { pid: process.pid, host: "sql-probe" }, isAlive: () => false },
    leaseMs: 0,
  };

  const runs = queryRuns(ctx, { limit: 200, now });
  const run = runs[0];

  if (!run) {
    throw new Error("Final SQL diagnostics require populated run data.");
  }

  const page = (limit: number) => runs.slice(0, limit).map((value) => value.id);
  const cursorRun = runs[49] ?? run;

  const key = db
    .query<{ key: string }, [string]>(
      "SELECT execution_key AS key FROM node_runs WHERE run_id=? ORDER BY execution_key LIMIT 1",
    )
    .get(run.id)?.key;

  const attempts = (key: string): Operation => [
    "execution.attempts",
    "nodes",
    () => readExecution(ctx, run.id, key, 0),
  ];

  const operations: Operation[] = [
    ["runs.latest", "runs", () => queryRuns(ctx, { limit: 50, now })],
    [
      "runs.slug-workspace",
      "runs",
      () => queryRuns(ctx, { slug: run.slug, workspace: run.workspace, limit: 50, now }),
    ],
    ["runs.failed", "runs", () => queryRuns(ctx, { status: "failed", limit: 50, now })],
    [
      "runs.page2",
      "runs",
      () => queryRuns(ctx, { before: encodeRunCursor(cursorRun), limit: 50, now }),
    ],
    ["runs.waiting", "runs", () => queryRuns(ctx, { waiting: true, limit: 50, now })],
    ["counts.by-definition", "runs", () => readRunCountsByDefinition(ctx)],
    ...[50, 100, 200].map(
      (count): Operation => [
        `pending-hooks.json-each-${count}`,
        "runs",
        () => readPendingHooks(ctx, page(count), now),
      ],
    ),
    ["logs.candidates", "feeds", () => readLogPage(ctx, { limit: 50 })],
    ["logs.text-candidates", "feeds", () => readLogPage(ctx, { text: "playground", limit: 50 })],
    ["logs.run-candidates", "feeds", () => readLogPage(ctx, { runId: run.id, limit: 50 })],
    ["events.candidates", "feeds", () => readEventPage(ctx, { limit: 50 })],
    ["events.run-candidates", "feeds", () => readEventPage(ctx, { runId: run.id, limit: 50 })],
    ["executions.page", "nodes", () => readNodePage(ctx, run.id, { scope: "[]", limit: 50 })],
    ...(key ? [attempts(key)] : []),
    ["scheduler.due", "turns", () => readDueTurns(ctx, now, 4)],
  ];

  return operations.flatMap(([operation, source, read]) => {
    driver.statements.length = 0;
    read();

    return driver.statements.map((statement, index) => ({
      name: index === 0 ? operation : `${operation}#${index + 1}`,
      operation,
      source: SOURCES[source],
      ...statement,
    }));
  });
}
