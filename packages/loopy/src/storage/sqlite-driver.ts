export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;
export type SqlResult<T = unknown> = {
  results?: T[];
  meta: { changes?: number };
};

/** D1 batches execute all statements atomically and roll back on failure. */
export interface SqliteStatement {
  bind(...values: SqlValue[]): SqliteStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<SqlResult<T>>;
  run(): Promise<SqlResult>;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  batch(statements: SqliteStatement[]): Promise<SqlResult[]>;
}
