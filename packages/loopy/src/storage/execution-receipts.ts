import type { ArtifactIdentity, TenantScope } from "../application/ports.js";
import type { ExecutionReceipt, ExecutionReceiptStore } from "../cloud/executor/controller.js";
import type { ExecutionKey } from "../runtime/remote-executor.js";
import { SqliteStore } from "./sqlite.js";
import type { SqliteDatabase } from "./sqlite-driver.js";

/** Apply after sqliteSchema through the host migration runner. Payload is an immutable artifact identity.
 * Keep receipts and artifacts outside workload access.
 */
export const executionReceiptSchema = [
  `CREATE TABLE loopy_execution_receipts (
    tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0), payload TEXT NOT NULL,
    PRIMARY KEY (tenant_id, run_id, attempt_id)
  )`,
] as const;

export class SqliteExecutionReceiptStore implements ExecutionReceiptStore {
  private readonly artifacts: SqliteStore;

  constructor(
    private readonly db: SqliteDatabase,
    readonly scope: TenantScope,
  ) {
    this.artifacts = new SqliteStore(db, scope);
  }

  async read(key: ExecutionKey): Promise<ExecutionReceipt | undefined> {
    this.authorize(key);
    const row = await this.db
      .prepare(
        "SELECT revision, payload FROM loopy_execution_receipts WHERE tenant_id=? AND run_id=? AND attempt_id=?",
      )
      .bind(key.tenantId, key.runId, key.attemptId)
      .first<{ revision: number; payload: string }>();
    if (!row) return undefined;
    const artifact: ArtifactIdentity = JSON.parse(row.payload);
    const bytes = await this.artifacts.get(artifact);
    if (!bytes) throw new Error("Missing execution receipt artifact");
    const receipt: ExecutionReceipt = JSON.parse(new TextDecoder().decode(bytes));
    if (!sameKey(key, receipt.key) || receipt.revision !== row.revision)
      throw new Error("Corrupt execution receipt identity or revision");
    return receipt;
  }

  async compareAndSwap(key: ExecutionKey, revision: number | undefined, next: ExecutionReceipt) {
    this.authorize(key);
    if (
      !sameKey(key, next.key) ||
      next.revision !== (revision === undefined ? 0 : revision + 1) ||
      !Number.isSafeInteger(next.revision) ||
      next.revision < 0
    )
      throw new Error("Invalid execution receipt CAS");
    // Persist immutable chunks before publishing their pointer. A losing CAS cannot change a winner.
    const artifact = await this.artifacts.put(new TextEncoder().encode(JSON.stringify(next)));
    const payload = JSON.stringify(artifact);
    const result =
      revision === undefined
        ? await this.db
            .prepare(
              `INSERT INTO loopy_execution_receipts (tenant_id, run_id, attempt_id, revision, payload)
         VALUES (?, ?, ?, 0, ?) ON CONFLICT(tenant_id, run_id, attempt_id) DO NOTHING`,
            )
            .bind(key.tenantId, key.runId, key.attemptId, payload)
            .run()
        : await this.db
            .prepare(
              `UPDATE loopy_execution_receipts SET revision=?, payload=?
         WHERE tenant_id=? AND run_id=? AND attempt_id=? AND revision=?`,
            )
            .bind(next.revision, payload, key.tenantId, key.runId, key.attemptId, revision)
            .run();
    if (result.meta.changes === undefined) throw new Error("SQL driver omitted CAS change count");
    return result.meta.changes === 1;
  }

  private authorize(key: ExecutionKey) {
    if (key.tenantId !== this.scope.tenantId) throw new Error("Execution tenant mismatch");
    if (!key.tenantId || !key.runId || !key.attemptId) throw new Error("Empty execution identity");
  }
}

function sameKey(left: ExecutionKey, right: ExecutionKey) {
  return (
    right &&
    left.tenantId === right.tenantId &&
    left.runId === right.runId &&
    left.attemptId === right.attemptId
  );
}
