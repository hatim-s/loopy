export type SqlValue = string | number | null;

export type SqlTransactionMode = "immediate" | "deferred";

export interface SqlStatement<Row, Params extends SqlValue[]> {
  get(...params: Params): Row | null | undefined;
  all(...params: Params): Row[];
  run(...params: Params): { changes: number };
}

export interface SqlDriver {
  query<Row = Record<string, SqlValue>, Params extends SqlValue[] = SqlValue[]>(
    sql: string,
  ): SqlStatement<Row, Params>;
  exec(sql: string): void;
  // Callbacks are synchronous. Both modes must roll back every write on a throw.
  transaction<T>(callback: () => T, mode: SqlTransactionMode): T;
  close?(): void;
}
