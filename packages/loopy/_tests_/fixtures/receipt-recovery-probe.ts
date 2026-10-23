import { ReceiptAuthority } from "../../../../apps/cloud/src/receipts-authority.js";
import type { ReceiptSql } from "../../../../apps/cloud/src/receipts-sql.js";
import type { AuthorityInput } from "../../src/contract/index.js";

export function receiptRecoveryProbe(db: ReceiptSql, input: AuthorityInput<"admit">) {
  const authority = new ReceiptAuthority(db);
  authority.admit(input);
  authority.complete({
    session: input.session,
    id: input.plan.id,
    requestHash: input.plan.requestHash,
    result: { sha256: "f".repeat(64), size: 20 },
  });
  authority.beginExport({ session: input.session, attemptId: input.plan.id, token: "active" });
  db.storage.sql
    .exec(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
    INSERT INTO receipt_attempts SELECT printf('%064x',x),kind,volume,json_set(record,'$.plan.id',printf('%064x',x)) FROM n,receipt_attempts WHERE id=?`,
      input.plan.id,
    )
    .toArray();
  db.storage.sql
    .exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
    INSERT INTO receipt_exports SELECT 'released-'||x,volume,0,json_set(record,'$.token','released-'||x) FROM n,receipt_exports WHERE token='active'`)
    .toArray();

  const attempts = db.storage.sql
    .exec(
      "EXPLAIN QUERY PLAN SELECT id FROM receipt_attempts WHERE kind='started' AND id>? ORDER BY id LIMIT ?",
      "",
      201,
    )
    .toArray();

  const exports = db.storage.sql
    .exec(
      "EXPLAIN QUERY PLAN SELECT token FROM receipt_exports WHERE active=1 AND token>? ORDER BY token LIMIT ?",
      "",
      201,
    )
    .toArray();

  const busy = db.storage.sql
    .exec(
      "EXPLAIN QUERY PLAN SELECT token FROM receipt_exports WHERE volume=? AND active=1 LIMIT 1",
      input.plan.volume,
    )
    .toArray();

  const counts = {
    attempts: db.storage.sql
      .exec("SELECT kind,count(*) AS count FROM receipt_attempts GROUP BY kind ORDER BY kind")
      .toArray(),
    exports: db.storage.sql
      .exec("SELECT active,count(*) AS count FROM receipt_exports GROUP BY active ORDER BY active")
      .toArray(),
  };

  const recovered = db.recoverable({ after: null, limit: 2 });

  const volumePagePlan = db.storage.sql
    .exec(
      "EXPLAIN QUERY PLAN SELECT token FROM receipt_exports WHERE active=1 AND volume=? AND token>? ORDER BY token LIMIT ?",
      input.plan.volume,
      "",
      201,
    )
    .toArray();

  db.storage.sql
    .exec(
      `WITH RECURSIVE n(x) AS (SELECT 1001 UNION ALL SELECT x+1 FROM n WHERE x<1201)
    INSERT INTO receipt_attempts SELECT printf('%064x',x),'started',volume,json_remove(json_set(record,'$.kind','started','$.plan.id',printf('%064x',x)),'$.result') FROM n,receipt_attempts WHERE id=?`,
      input.plan.id,
    )
    .toArray();
  const exactVolume = db.exportGuards({ after: null, limit: 1, volume: input.plan.volume });

  const otherVolume = db.exportGuards({
    after: null,
    limit: 1,
    volume: `loopy-workspace-${"0".repeat(64)}`,
  });

  db.storage.sql
    .exec("UPDATE receipt_attempts SET record='{}' WHERE id=?", input.plan.id)
    .toArray();
  let malformed = "did not reject";

  try {
    db.read(input.plan.id);
  } catch (error) {
    malformed = error instanceof Error ? error.message : "non-error rejection";
  }

  return {
    attempts,
    exports,
    busy,
    counts,
    recovered,
    malformed,
    volumePagePlan,
    exactVolume,
    otherVolume,
  };
}
