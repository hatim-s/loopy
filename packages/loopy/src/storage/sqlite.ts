import type {
  AdmissionRequest,
  AdmissionResult,
  AdmissionStore,
  ArtifactIdentity,
  ArtifactStore,
  DispatchIntent,
  TenantScope,
  WorkflowCatalog,
  WorkflowVersion,
} from "../application/ports.js";
import type { DispatchDelivery, OutboxStore } from "../cloud/dispatch.js";
import type { Json, RunEvent, RunRecord } from "../core/model.js";
import type {
  DurableRunRepository,
  DurableRunState,
  TransitionLease,
} from "../runtime/transition-store.js";
import type { SqliteDatabase, SqlValue } from "./sqlite-driver.js";

export type StorageLimits = {
  artifactBytes: number;
  sourceFiles: number;
  versionBytes: number;
  stateBytes: number;
};
const defaults: StorageLimits = {
  artifactBytes: 1_000_000,
  sourceFiles: 100,
  versionBytes: 512_000,
  stateBytes: 512_000,
};
const encode = (value: unknown, limit: number) => {
  const data = JSON.stringify(value);
  if (new TextEncoder().encode(data).length > limit)
    throw new Error("Storage payload exceeds limit");
  return data;
};
export class SqliteStore
  implements AdmissionStore, ArtifactStore, WorkflowCatalog, DurableRunRepository, OutboxStore
{
  readonly limits: StorageLimits;
  constructor(
    readonly db: SqliteDatabase,
    readonly scope: TenantScope,
    limits: Partial<StorageLimits> = {},
    readonly now = () => new Date(),
  ) {
    if (!scope.tenantId) throw new Error("Tenant is required");
    this.limits = { ...defaults, ...limits };
    for (const key of Object.keys(defaults) as (keyof StorageLimits)[])
      if (
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > defaults[key]
      )
        throw new Error("Invalid storage limit");
  }
  private sql(query: string, ...values: SqlValue[]) {
    const tenantAt = query.indexOf("tenant_id=?");
    const index = tenantAt < 0 ? 0 : (query.slice(0, tenantAt).match(/\?/g) ?? []).length;
    values.splice(index, 0, this.scope.tenantId);
    return this.db.prepare(query).bind(...values);
  }
  async put(bytes: Uint8Array): Promise<ArtifactIdentity> {
    if (bytes.length > this.limits.artifactBytes) throw new Error("Artifact exceeds limit");
    const snapshot = new Uint8Array(bytes);
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", snapshot)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const identity = { id: sha256, sha256, bytes: snapshot.length };
    await this.sql(
      "INSERT INTO loopy_artifacts(tenant_id,id,sha256,bytes,content) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,id) DO NOTHING",
      identity.id,
      sha256,
      snapshot.length,
      snapshot,
    ).run();
    return identity;
  }
  async get(identity: ArtifactIdentity): Promise<Uint8Array | undefined> {
    const row = await this.sql(
      "SELECT content FROM loopy_artifacts WHERE tenant_id=? AND id=? AND sha256=? AND bytes=?",
      identity.id,
      identity.sha256,
      identity.bytes,
    ).first<{ content: ArrayBuffer | Uint8Array }>();
    return row ? new Uint8Array(row.content) : undefined;
  }
  async getVersion(id: string): Promise<WorkflowVersion | undefined> {
    const row = await this.sql(
      "SELECT payload FROM loopy_versions WHERE tenant_id=? AND id=?",
      id,
    ).first<{ payload: string }>();
    return row ? (JSON.parse(row.payload) as WorkflowVersion) : undefined;
  }
  async publish(version: WorkflowVersion): Promise<WorkflowVersion> {
    if (version.files.length > this.limits.sourceFiles) throw new Error("Too many source files");
    if (version.publication && !(await this.get(version.publication.bundle)))
      throw new Error("Missing publication bundle artifact");
    const paths = new Set<string>();
    for (const file of version.files) {
      if (
        !file.path ||
        file.path.startsWith("/") ||
        file.path.split("/").some((part) => part === ".." || part === "." || !part) ||
        paths.has(file.path)
      )
        throw new Error("Invalid source path");
      paths.add(file.path);
      if (!(await this.get(file.artifact))) throw new Error("Missing source artifact");
    }
    if (!paths.has(version.entrypoint)) throw new Error("Entrypoint is missing");
    const payload = encode(version, this.limits.versionBytes);
    await this.sql(
      "INSERT INTO loopy_versions(tenant_id,id,slug,payload) VALUES(?,?,?,?) ON CONFLICT(tenant_id,id) DO NOTHING",
      version.id,
      version.slug,
      payload,
    ).run();
    const existing = await this.getVersion(version.id);
    if (!existing || JSON.stringify(existing) !== payload)
      throw new Error("Immutable version conflict");
    return existing;
  }
  async admit(
    request: AdmissionRequest,
    run: RunRecord,
    dispatch: DispatchIntent,
  ): Promise<AdmissionResult> {
    if (!request.idempotencyKey || !request.fingerprint || dispatch.runId !== run.id)
      throw new Error("Invalid admission");
    const version = await this.getVersion(request.versionId);
    if (
      !version ||
      version.graphHash !== run.workflowHash ||
      JSON.stringify(version.workflow) !== JSON.stringify(run.workflow) ||
      JSON.stringify(request.input) !== JSON.stringify(run.input) ||
      JSON.stringify(version.runtime) !== JSON.stringify(dispatch.runtime)
    )
      throw new Error("Admission version mismatch");
    const payload = encode(run, this.limits.stateBytes);
    const result = await this.db.batch([
      this.sql(
        "INSERT INTO loopy_runs(tenant_id,id,admission_key,fingerprint,dispatch_id,version_id,payload) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,admission_key) DO NOTHING",
        run.id,
        request.idempotencyKey,
        request.fingerprint,
        dispatch.id,
        request.versionId,
        payload,
      ),
      this.sql(
        "INSERT INTO loopy_outbox(tenant_id,id,run_id,kind,payload,created_at) SELECT tenant_id,?,id,'dispatch',?,? FROM loopy_runs WHERE tenant_id=? AND admission_key=? AND id=? AND fingerprint=? AND dispatch_id=? AND NOT EXISTS (SELECT 1 FROM loopy_outbox o WHERE o.tenant_id=loopy_runs.tenant_id AND o.id=? AND o.run_id=loopy_runs.id)",
        dispatch.id,
        encode(dispatch, this.limits.stateBytes),
        this.now().toISOString(),
        request.idempotencyKey,
        run.id,
        request.fingerprint,
        dispatch.id,
        dispatch.id,
      ),
    ]);
    const row = await this.sql(
      "SELECT r.payload,r.fingerprint,o.payload AS dispatch FROM loopy_runs r JOIN loopy_outbox o ON o.tenant_id=r.tenant_id AND o.run_id=r.id AND o.kind='dispatch' AND o.id=r.dispatch_id WHERE r.tenant_id=? AND r.admission_key=?",
      request.idempotencyKey,
    ).first<{ payload: string; fingerprint: string; dispatch: string }>();
    if (!row || row.fingerprint !== request.fingerprint) return { state: "conflict" };
    return {
      state: result[0]?.meta.changes ? "created" : "existing",
      run: JSON.parse(row.payload) as RunRecord,
      dispatch: JSON.parse(row.dispatch) as DispatchIntent,
    };
  }
  async read(runId: string): Promise<DurableRunState | undefined> {
    const row = await this.sql(
      "SELECT payload,state,revision,cancel_requested FROM loopy_runs WHERE tenant_id=? AND id=?",
      runId,
    ).first<{
      payload: string;
      state: string | null;
      revision: number;
      cancel_requested: number;
    }>();
    if (!row) return undefined;
    if (!row.state)
      return {
        revision: row.revision,
        run: JSON.parse(row.payload) as RunRecord,
        attempts: [],
        workspace: { state: "unallocated" },
        cancelRequested: !!row.cancel_requested,
      };
    return {
      ...(JSON.parse(row.state) as DurableRunState),
      revision: row.revision,
      cancelRequested: !!row.cancel_requested,
    };
  }
  async acquire(runId: string, token: string, ttlMs: number): Promise<TransitionLease | undefined> {
    if (!token || !Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 60_000)
      throw new Error("Invalid lease");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const row = await this.sql(
      "UPDATE loopy_runs SET lease_token=?,lease_fence=lease_fence+1,lease_expiry=? WHERE tenant_id=? AND id=? AND (lease_token IS NULL OR lease_expiry<=?) RETURNING lease_fence",
      token,
      expiresAt,
      runId,
      now.toISOString(),
    ).first<{ lease_fence: number }>();
    return row ? { runId, token, fence: row.lease_fence, expiresAt } : undefined;
  }
  async commit(
    lease: TransitionLease,
    expectedRevision: number,
    state: DurableRunState,
    records: {
      events?: RunEvent[];
      usage?: { attemptId: string; metric: string; quantity: number }[];
      analytics?: { id: string; data: Json }[];
    } = {},
  ): Promise<boolean> {
    if (state.run.id !== lease.runId || state.revision !== expectedRevision)
      throw new Error("Invalid transition");
    if (
      state.intent &&
      (state.intent.key.tenantId !== this.scope.tenantId || state.intent.key.runId !== lease.runId)
    )
      throw new Error("Foreign execution intent");
    const prior = await this.read(lease.runId);
    if (!prior || prior.revision !== expectedRevision) return false;
    for (const key of [
      "id",
      "slug",
      "workflow",
      "workflowHash",
      "input",
      "options",
      "createdAt",
    ] as const) {
      if (JSON.stringify(prior.run[key]) !== JSON.stringify(state.run[key]))
        throw new Error("Immutable run field changed");
    }
    const attemptIds = new Set<string>();
    for (const attempt of state.attempts) {
      if (
        attempt.runId !== lease.runId ||
        attemptIds.has(attempt.id) ||
        !Number.isSafeInteger(attempt.number) ||
        attempt.number < 1
      )
        throw new Error("Invalid attempt identity");
      attemptIds.add(attempt.id);
      const original = prior.attempts.find((item) => item.id === attempt.id);
      if (original)
        for (const key of ["id", "runId", "nodeId", "number", "input", "startedAt"] as const)
          if (JSON.stringify(original[key]) !== JSON.stringify(attempt[key]))
            throw new Error("Immutable attempt field changed");
    }
    if (prior.attempts.some((attempt) => !attemptIds.has(attempt.id)))
      throw new Error("Attempt history cannot be removed");
    const commitToken = crypto.randomUUID();
    const events = records.events ?? [];
    const usage = records.usage ?? [];
    const analytics = records.analytics ?? [];
    if (events.length + usage.length + analytics.length > 100)
      throw new Error("Too many transition records");
    const update = this.sql(
      "UPDATE loopy_runs SET state=?,payload=?,commit_token=?,revision=revision+1 WHERE tenant_id=? AND id=? AND revision=? AND lease_token=? AND lease_fence=? AND lease_expiry>?",
      encode(state, this.limits.stateBytes),
      encode(state.run, this.limits.stateBytes),
      commitToken,
      lease.runId,
      expectedRevision,
      lease.token,
      lease.fence,
      this.now().toISOString(),
    );
    const statements = [update];
    for (const event of events) {
      if (
        event.runId !== lease.runId ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1
      )
        throw new Error("Invalid run event");
      statements.push(
        this.sql(
          "INSERT INTO loopy_events(tenant_id,run_id,sequence,payload,created_at) SELECT tenant_id,id,?,?,? FROM loopy_runs WHERE tenant_id=? AND id=? AND commit_token=?",
          event.sequence,
          encode(event, 65536),
          event.createdAt,
          lease.runId,
          commitToken,
        ),
      );
    }
    for (const item of usage) {
      if (
        !Number.isFinite(item.quantity) ||
        item.quantity < 0 ||
        !state.attempts.some((attempt) => attempt.id === item.attemptId)
      )
        throw new Error("Invalid usage");
      statements.push(
        this.sql(
          "INSERT INTO loopy_usage(tenant_id,run_id,attempt_id,metric,quantity) SELECT tenant_id,id,?,?,? FROM loopy_runs WHERE tenant_id=? AND id=? AND commit_token=?",
          item.attemptId,
          item.metric,
          item.quantity,
          lease.runId,
          commitToken,
        ),
      );
    }
    for (const item of analytics)
      statements.push(
        this.sql(
          "INSERT INTO loopy_outbox(tenant_id,id,run_id,kind,payload,created_at) SELECT tenant_id,?,id,'analytics',?,? FROM loopy_runs WHERE tenant_id=? AND id=? AND commit_token=?",
          item.id,
          encode(item.data, 65536),
          this.now().toISOString(),
          lease.runId,
          commitToken,
        ),
      );
    const results = await this.db.batch(statements);
    return results[0]?.meta.changes === 1;
  }
  async getEvents(runId: string, after = 0, limit = 100): Promise<RunEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Invalid event limit");
    const rows = await this.sql(
      "SELECT payload FROM loopy_events WHERE tenant_id=? AND run_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      runId,
      after,
      limit,
    ).all<{ payload: string }>();
    return (rows.results ?? []).map((row) => JSON.parse(row.payload) as RunEvent);
  }
  async pruneEvents(before: string, limit = 100): Promise<number> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isFinite(Date.parse(before))
    )
      throw new Error("Invalid retention request");
    const result = await this.sql(
      "DELETE FROM loopy_events WHERE tenant_id=? AND rowid IN (SELECT rowid FROM loopy_events WHERE tenant_id=? AND created_at<? ORDER BY created_at LIMIT ?)",
      this.scope.tenantId,
      before,
      limit,
    ).run();
    return result.meta.changes ?? 0;
  }

  async release(lease: TransitionLease): Promise<void> {
    await this.sql(
      "UPDATE loopy_runs SET lease_token=NULL,lease_expiry=NULL WHERE tenant_id=? AND id=? AND lease_token=? AND lease_fence=?",
      lease.runId,
      lease.token,
      lease.fence,
    ).run();
  }
  async requestCancel(runId: string): Promise<void> {
    const row = await this.sql(
      "SELECT o.payload FROM loopy_runs r JOIN loopy_outbox o ON o.tenant_id=r.tenant_id AND o.id=r.dispatch_id WHERE r.tenant_id=? AND r.id=?",
      runId,
    ).first<{ payload: string }>();
    if (!row) return;
    const token = crypto.randomUUID();
    const dispatch = {
      ...(JSON.parse(row.payload) as DispatchIntent & { kind?: "start" | "cancel" }),
      id: crypto.randomUUID(),
      kind: "cancel" as const,
    };
    await this.db.batch([
      this.sql(
        "UPDATE loopy_runs SET cancel_requested=1,revision=revision+1,commit_token=? WHERE tenant_id=? AND id=? AND cancel_requested=0",
        token,
        runId,
      ),
      this.sql(
        "INSERT INTO loopy_outbox(tenant_id,id,run_id,kind,payload,created_at) SELECT tenant_id,?,id,'dispatch',?,? FROM loopy_runs WHERE tenant_id=? AND id=? AND commit_token=?",
        dispatch.id,
        encode(dispatch, this.limits.stateBytes),
        this.now().toISOString(),
        runId,
        token,
      ),
    ]);
  }
  async claimDispatch(token: string, ttlMs: number, limit: number): Promise<DispatchDelivery[]> {
    if (
      !token ||
      !Number.isInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 60000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("Invalid dispatch lease");
    const now = this.now();
    const rows = await this.sql(
      "UPDATE loopy_outbox SET lease_token=?,lease_expiry=? WHERE tenant_id=? AND id IN (SELECT id FROM loopy_outbox WHERE tenant_id=? AND kind='dispatch' AND delivered_at IS NULL AND (lease_token IS NULL OR lease_expiry<=?) ORDER BY created_at,id LIMIT ?) RETURNING payload",
      token,
      new Date(now.getTime() + ttlMs).toISOString(),
      this.scope.tenantId,
      now.toISOString(),
      limit,
    ).all<{ payload: string }>();
    return (rows.results ?? []).map((row) => ({
      kind: "start",
      ...(JSON.parse(row.payload) as DispatchIntent & { kind?: "start" | "cancel" }),
      leaseToken: token,
    }));
  }
  async ackDispatch(id: string, token: string): Promise<boolean> {
    const result = await this.sql(
      "UPDATE loopy_outbox SET delivered_at=?,lease_token=NULL,lease_expiry=NULL WHERE tenant_id=? AND id=? AND kind='dispatch' AND delivered_at IS NULL AND lease_token=? AND lease_expiry>?",
      this.now().toISOString(),
      id,
      token,
      this.now().toISOString(),
    ).run();
    return result.meta.changes === 1;
  }
  async retryDispatch(id: string, token: string, error: string): Promise<boolean> {
    const result = await this.sql(
      "UPDATE loopy_outbox SET lease_token=NULL,lease_expiry=NULL,error=? WHERE tenant_id=? AND id=? AND kind='dispatch' AND delivered_at IS NULL AND lease_token=? AND lease_expiry>?",
      encode(error, 4096),
      id,
      token,
      this.now().toISOString(),
    ).run();
    return result.meta.changes === 1;
  }
  async claimAnalytics(
    token: string,
    ttlMs: number,
    limit = 20,
  ): Promise<{ id: string; runId: string; data: Json; leaseToken: string }[]> {
    if (
      !token ||
      !Number.isInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 60000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("Invalid analytics lease");
    const now = this.now();
    const rows = await this.sql(
      "UPDATE loopy_outbox SET lease_token=?,lease_expiry=? WHERE tenant_id=? AND id IN (SELECT id FROM loopy_outbox WHERE tenant_id=? AND kind='analytics' AND delivered_at IS NULL AND (lease_token IS NULL OR lease_expiry<=?) ORDER BY created_at,id LIMIT ?) RETURNING id,run_id,payload",
      token,
      new Date(now.getTime() + ttlMs).toISOString(),
      this.scope.tenantId,
      now.toISOString(),
      limit,
    ).all<{ id: string; run_id: string; payload: string }>();
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      runId: row.run_id,
      data: JSON.parse(row.payload) as Json,
      leaseToken: token,
    }));
  }
  async ackAnalytics(id: string, token: string): Promise<boolean> {
    const result = await this.sql(
      "UPDATE loopy_outbox SET delivered_at=?,lease_token=NULL,lease_expiry=NULL WHERE tenant_id=? AND id=? AND kind='analytics' AND delivered_at IS NULL AND lease_token=? AND lease_expiry>?",
      this.now().toISOString(),
      id,
      token,
      this.now().toISOString(),
    ).run();
    return result.meta.changes === 1;
  }
  async pruneAnalytics(before: string, limit = 100): Promise<number> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isFinite(Date.parse(before))
    )
      throw new Error("Invalid retention request");
    const result = await this.sql(
      "DELETE FROM loopy_outbox WHERE tenant_id=? AND id IN (SELECT id FROM loopy_outbox WHERE tenant_id=? AND kind='analytics' AND delivered_at<? ORDER BY delivered_at LIMIT ?)",
      this.scope.tenantId,
      before,
      limit,
    ).run();
    return result.meta.changes ?? 0;
  }
}
