import { Database } from "bun:sqlite";
import type { SqlDriver, SqlStatement, SqlTransactionMode, SqlValue } from "./driver";

export class BunSqlDriver implements SqlDriver {
  private readonly db: Database;

  constructor(file: string) {
    this.db = new Database(file, { create: true });
  }

  query<Row = Record<string, SqlValue>, Params extends SqlValue[] = SqlValue[]>(
    sql: string,
  ): SqlStatement<Row, Params> {
    const statement = this.db.query<Row, SqlValue[]>(sql);

    return {
      get: (...params) => statement.get(...params),
      all: (...params) => statement.all(...params),
      run: (...params) => ({ changes: statement.run(...params).changes }),
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(callback: () => T, mode: SqlTransactionMode): T {
    return this.db.transaction(callback)[mode]();
  }

  close(): void {
    this.db.close();
  }
}
