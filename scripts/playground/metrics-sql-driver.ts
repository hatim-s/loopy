import { Database } from "bun:sqlite";
import type { SqlDriver, SqlStatement, SqlValue } from "../../packages/loopy/src/store/portable.js";
import { distribution } from "./metrics-statistics.js";

export class DiagnosticDriver implements SqlDriver {
  readonly db: Database;
  operation = "initialize";
  readonly traces: {
    operation: string;
    sql: string;
    durationMs: number;
    rows: number;
    parameterCount: number;
    plan: { id: number; parent: number; detail: string }[];
  }[] = [];

  constructor(path: string) {
    this.db = new Database(path, { readonly: true });
  }

  query<Row, Params extends SqlValue[]>(sql: string): SqlStatement<Row, Params> {
    const statement = this.db.query<Row, SqlValue[]>(sql);

    const read = (...params: Params) => {
      const start = performance.now();
      const result = statement.all(...params);
      const durationMs = performance.now() - start;

      const previous = this.traces.find(
        (trace) => trace.operation === this.operation && trace.sql === sql,
      );

      const plan =
        previous?.plan ??
        this.db
          .query<{ id: number; parent: number; detail: string }, SqlValue[]>(
            `EXPLAIN QUERY PLAN ${sql}`,
          )
          .all(...params);

      this.traces.push({
        operation: this.operation,
        sql,
        durationMs,
        rows: result.length,
        parameterCount: params.length,
        plan,
      });

      return result;
    };

    return {
      get: (...params) => read(...params)[0] ?? null,
      all: read,
      run: () => {
        throw new Error("Diagnostic driver rejects writes.");
      },
    };
  }

  exec(): never {
    throw new Error("Diagnostic driver rejects exec.");
  }

  transaction<T>(callback: () => T): T {
    // The copied database is immutable during analysis; no write transaction is needed.
    return callback();
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
