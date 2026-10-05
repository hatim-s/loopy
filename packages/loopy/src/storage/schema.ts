/** Apply each migration once through the host's migration runner. */
export const sqliteSchema = [
  `CREATE TABLE loopy_artifacts (
    tenant_id TEXT NOT NULL, id TEXT NOT NULL, sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes >= 0 AND bytes <= 8000000),
    PRIMARY KEY (tenant_id, id)
  )`,
  `CREATE TABLE loopy_artifact_chunks (
    tenant_id TEXT NOT NULL, artifact_id TEXT NOT NULL, part INTEGER NOT NULL CHECK(part >= 0),
    content BLOB NOT NULL CHECK(length(content) <= 262144),
    PRIMARY KEY (tenant_id, artifact_id, part),
    FOREIGN KEY (tenant_id, artifact_id) REFERENCES loopy_artifacts(tenant_id, id)
  )`,
  `CREATE TABLE loopy_versions (
    tenant_id TEXT NOT NULL, id TEXT NOT NULL, slug TEXT NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY (tenant_id, id)
  )`,
  `CREATE TABLE loopy_runs (
    tenant_id TEXT NOT NULL, id TEXT NOT NULL, admission_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL, dispatch_id TEXT NOT NULL, version_id TEXT NOT NULL, payload TEXT NOT NULL,
    state TEXT, commit_token TEXT, revision INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT, lease_fence INTEGER NOT NULL DEFAULT 0, lease_expiry TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, admission_key),
    FOREIGN KEY (tenant_id, version_id) REFERENCES loopy_versions(tenant_id, id)
  )`,
  `CREATE INDEX loopy_runs_recovery ON loopy_runs(tenant_id, id)
    WHERE json_extract(payload, '$.status') IN ('pending', 'running') OR json_type(state, '$.intent') = 'object'`,
  `CREATE TABLE loopy_outbox (
    tenant_id TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('dispatch', 'analytics')), payload TEXT NOT NULL,
    created_at TEXT NOT NULL, delivered_at TEXT, lease_token TEXT, lease_expiry TEXT, error TEXT,
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, run_id) REFERENCES loopy_runs(tenant_id, id)
  )`,
  `CREATE INDEX loopy_outbox_pending ON loopy_outbox(tenant_id, kind, delivered_at, created_at)`,
  `CREATE INDEX loopy_dispatch_recovery ON loopy_outbox(tenant_id)
    WHERE kind = 'dispatch' AND delivered_at IS NULL`,
  `CREATE TABLE loopy_events (
    tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    payload TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(tenant_id, run_id, sequence),
    FOREIGN KEY(tenant_id, run_id) REFERENCES loopy_runs(tenant_id, id)
  )`,
  `CREATE TABLE loopy_usage (
    tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    metric TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity >= 0),
    PRIMARY KEY(tenant_id, run_id, attempt_id, metric),
    FOREIGN KEY(tenant_id, run_id) REFERENCES loopy_runs(tenant_id, id)
  )`,
] as const;
