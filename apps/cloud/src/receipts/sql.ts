import type { DurableObjectStorage } from "@cloudflare/workers-types";
import {
  type AttemptRecord,
  AuthorityError,
  type AuthorityInput,
  type AuthorityOutput,
  type AuthoritySession,
  attemptRecordSchema,
  authoritySessionSchema,
  decodeBoundary,
  type ExportRecord,
  exportRecordSchema,
} from "../../../../packages/loopy/src/contract";

export class ReceiptSql {
  constructor(
    readonly storage: DurableObjectStorage,
    namespace: string,
    root: string,
  ) {
    storage.transactionSync(() => {
      storage.sql
        .exec(`
        CREATE TABLE IF NOT EXISTS receipt_config (id INTEGER PRIMARY KEY CHECK(id=1), namespace TEXT NOT NULL, root TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipt_sessions (epoch INTEGER PRIMARY KEY, nonce TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS receipt_attempts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, volume TEXT NOT NULL, record TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS receipt_attempt_volume ON receipt_attempts(volume,kind);
        CREATE INDEX IF NOT EXISTS receipt_attempt_recovery ON receipt_attempts(kind,id);
        CREATE TABLE IF NOT EXISTS receipt_exports (token TEXT PRIMARY KEY, volume TEXT NOT NULL, active INTEGER NOT NULL, record TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS receipt_export_volume ON receipt_exports(volume) WHERE active=1;
        CREATE INDEX IF NOT EXISTS receipt_export_recovery ON receipt_exports(token) WHERE active=1;
      `)
        .toArray();
      storage.sql
        .exec("INSERT OR IGNORE INTO receipt_config VALUES (1,?,?)", namespace, root)
        .toArray();

      const saved = storage.sql
        .exec<{ namespace: string; root: string }>(
          "SELECT namespace,root FROM receipt_config WHERE id=1",
        )
        .one();

      if (saved.namespace !== namespace || saved.root !== root) {
        throw new Error(
          "Receipt authority namespace/root changed. Restore the original configuration.",
        );
      }
    });
  }

  current(): AuthoritySession | null {
    const row = this.storage.sql
      .exec<{ epoch: number; nonce: string }>(
        "SELECT epoch,nonce FROM receipt_sessions ORDER BY epoch DESC LIMIT 1",
      )
      .toArray()[0];

    return row ? decodeBoundary(authoritySessionSchema)(row) : null;
  }

  checkSession(session: AuthoritySession): void {
    const current = this.current();

    if (current?.epoch !== session.epoch || current.nonce !== session.nonce) {
      throw new AuthorityError("stale_session");
    }
  }

  openSession(input: AuthorityInput<"openSession">): AuthoritySession {
    return this.storage.transactionSync(() => {
      const current = this.current();

      if (current?.nonce === input.nonce) {
        return current;
      }

      const reused = this.storage.sql
        .exec("SELECT epoch FROM receipt_sessions WHERE nonce=?", input.nonce)
        .toArray().length;

      if ((current?.epoch ?? 0) !== input.expectedEpoch || reused) {
        throw new AuthorityError("stale_session");
      }

      const session = { epoch: input.expectedEpoch + 1, nonce: input.nonce };
      this.storage.sql
        .exec("INSERT INTO receipt_sessions VALUES (?,?)", session.epoch, session.nonce)
        .toArray();

      return session;
    });
  }

  read(id: string): AttemptRecord | null {
    const row = this.storage.sql
      .exec<{ id: string; kind: string; volume: string; record: string }>(
        "SELECT * FROM receipt_attempts WHERE id=?",
        id,
      )
      .toArray()[0];

    if (!row) {
      return null;
    }

    const record = decodeBoundary(attemptRecordSchema)(JSON.parse(row.record));

    if (
      record.plan.id !== row.id ||
      record.kind !== row.kind ||
      record.plan.volume !== row.volume ||
      (record.kind === "finished" && record.result.kind !== "blob")
    ) {
      throw new Error("Durable receipt record does not match its SQL identity.");
    }

    return record;
  }

  write(record: AttemptRecord): void {
    this.storage.sql
      .exec(
        "INSERT INTO receipt_attempts VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,record=excluded.record",
        record.plan.id,
        record.kind,
        record.plan.volume,
        JSON.stringify(record),
      )
      .toArray();
  }

  export(token: string): { record: ExportRecord; active: boolean } | null {
    const row = this.storage.sql
      .exec<{ token: string; volume: string; active: number; record: string }>(
        "SELECT * FROM receipt_exports WHERE token=?",
        token,
      )
      .toArray()[0];

    if (!row) {
      return null;
    }

    const record = decodeBoundary(exportRecordSchema)(JSON.parse(row.record));

    if (
      record.token !== row.token ||
      record.volume !== row.volume ||
      ![0, 1].includes(row.active)
    ) {
      throw new Error("Durable export record does not match its SQL identity.");
    }

    return { record, active: row.active === 1 };
  }

  busy(volume: string): boolean {
    return (
      this.storage.sql
        .exec("SELECT token FROM receipt_exports WHERE volume=? AND active=1 LIMIT 1", volume)
        .toArray().length > 0
    );
  }

  exportGuards(input: AuthorityInput<"exportGuards">): AuthorityOutput<"exportGuards"> {
    return this.storage.transactionSync(() => {
      const rows = this.storage.sql
        .exec<{ token: string }>(
          "SELECT token FROM receipt_exports WHERE active=1 AND volume=? AND token>? ORDER BY token LIMIT ?",
          input.volume,
          input.after ?? "",
          input.limit + 1,
        )
        .toArray();

      const exports = rows.slice(0, input.limit).map(({ token }) => {
        const guard = this.export(token);

        if (!guard?.active) {
          throw new Error("Export guard query returned a missing or inactive guard.");
        }

        return guard.record;
      });

      return { exports, next: rows.length > input.limit ? (exports.at(-1)?.token ?? null) : null };
    });
  }

  recoverable(input: AuthorityInput<"recoverable">): AuthorityOutput<"recoverable"> {
    return this.storage.transactionSync(() => {
      if (input.after !== null && (!/^[ae]:/.test(input.after) || input.after.length > 258)) {
        throw new AuthorityError("invalid_state");
      }

      const afterExport = input.after?.startsWith("e:") ?? false;

      const attempts = afterExport
        ? []
        : this.storage.sql
            .exec<{ id: string }>(
              "SELECT id FROM receipt_attempts WHERE kind='started' AND id>? ORDER BY id LIMIT ?",
              input.after?.slice(2) ?? "",
              input.limit + 1,
            )
            .toArray();

      const remaining = input.limit + 1 - attempts.length;

      const exports =
        remaining === 0
          ? []
          : this.storage.sql
              .exec<{ token: string }>(
                "SELECT token FROM receipt_exports WHERE active=1 AND token>? ORDER BY token LIMIT ?",
                afterExport ? (input.after?.slice(2) ?? "") : "",
                remaining,
              )
              .toArray();

      const rows = [
        ...attempts.map(({ id }) => ({ cursor: `a:${id}`, id, kind: "attempt" as const })),
        ...exports.map(({ token }) => ({
          cursor: `e:${token}`,
          id: token,
          kind: "export" as const,
        })),
      ];

      const result: AuthorityOutput<"recoverable"> = { attempts: [], exports: [], next: null };

      for (const row of rows.slice(0, input.limit)) {
        if (row.kind === "attempt") {
          const record = this.read(row.id);

          if (!record || record.kind !== "started") {
            throw new Error("Recoverable attempt is missing its started record.");
          }

          result.attempts.push(record);
        } else {
          const guard = this.export(row.id);

          if (!guard?.active) {
            throw new Error("Recoverable export is missing its active guard.");
          }

          result.exports.push(guard.record);
        }
      }

      result.next = rows.length > input.limit ? (rows[input.limit - 1]?.cursor ?? null) : null;

      return result;
    });
  }
}
