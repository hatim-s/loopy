import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { SqlDriver, SqlStatement, SqlValue } from "../../../packages/loopy/src/store/portable";

export class DurableSqlDriver implements SqlDriver {
  constructor(private readonly storage: DurableObjectStorage) {}

  query<Row, Params extends SqlValue[]>(sql: string): SqlStatement<Row, Params> {
    const all = (...params: Params): Row[] => {
      // SAFETY: The shared SQL store owns row shapes; the driver consumes the cursor before any await.
      return this.storage.sql.exec(sql, ...params).toArray() as Row[];
    };

    return {
      all,
      get: (...params) => all(...params)[0] ?? null,
      run: (...params) => {
        this.storage.sql.exec(sql, ...params).toArray();
        const row = this.storage.sql.exec<{ changes: number }>("SELECT changes() AS changes").one();

        return { changes: row.changes };
      },
    };
  }

  exec(sql: string): void {
    this.storage.sql.exec(sql).toArray();
  }

  transaction<T>(callback: () => T): T {
    return this.storage.transactionSync(callback);
  }
}
