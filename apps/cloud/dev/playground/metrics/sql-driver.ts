import { Database } from "bun:sqlite";
import type { SqlValue } from "@loopy/runtime/store/portable";
import { distribution } from "../../shared/stats";

type PlanRow = { id: number; parent: number; detail: string };

// Opens the copied snapshot read-only and records timing and the query plan for every read.
export class DiagnosticReader {
  readonly db: Database;
  readonly traces: {
    operation: string;
    sql: string;
    durationMs: number;
    rows: number;
    parameterCount: number;
    plan: PlanRow[];
  }[] = [];

  constructor(path: string) {
    this.db = new Database(path, { readonly: true });
  }

  all(operation: string, sql: string, bindings: SqlValue[]) {
    const start = performance.now();
    const result = this.db.query<unknown, SqlValue[]>(sql).all(...bindings);
    const durationMs = performance.now() - start;

    const plan =
      this.traces.find((trace) => trace.operation === operation && trace.sql === sql)?.plan ??
      this.db.query<PlanRow, SqlValue[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings);

    this.traces.push({
      operation,
      sql,
      durationMs,
      rows: result.length,
      parameterCount: bindings.length,
      plan,
    });

    return result;
  }

  summary() {
    return [...new Set(this.traces.map((trace) => trace.operation))].map((operation) => {
      const selected = this.traces.filter((trace) => trace.operation === operation);

      return {
        operation,
        calls: selected.length,
        sqlMs: distribution(selected.map((trace) => trace.durationMs)),
        rows: selected.reduce((sum, trace) => sum + trace.rows, 0),
      };
    });
  }
}
