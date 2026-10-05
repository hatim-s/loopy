import type { Json, RunRecord, Workflow } from "../core/model.js";

export type TenantScope = { readonly tenantId: string };
export type ArtifactIdentity = {
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
};
export type SourceFile = { readonly path: string; readonly artifact: ArtifactIdentity };
export type RuntimeIdentity = { readonly build: string; readonly graphSchema: 1 };
export type WorkflowVersion = {
  readonly id: string;
  readonly slug: string;
  readonly workflow: Workflow;
  readonly graphHash: string;
  readonly files: readonly SourceFile[];
  readonly entrypoint: string;
  readonly compiler: string;
  readonly runtime: RuntimeIdentity;
  readonly imageDigest: string;
  readonly publication?: {
    readonly bundle: ArtifactIdentity;
    readonly lockfileHash: string;
    readonly sourceMappings: readonly { readonly source: string; readonly target: string }[];
  };
};
export type AdmissionRequest = {
  idempotencyKey: string;
  fingerprint: string;
  versionId: string;
  input: Json;
};
export type DispatchIntent = { id: string; runId: string; runtime: RuntimeIdentity };
export type AdmissionResult =
  | { state: "created" | "existing"; run: RunRecord; dispatch: DispatchIntent }
  | { state: "conflict" };

/** Bound by the server to a tenant. Admission atomically commits run and dispatch.
 * Same key and fingerprint returns the committed run; changed fingerprint conflicts.
 */
export interface AdmissionStore {
  readonly scope: TenantScope;
  admit(
    request: AdmissionRequest,
    run: RunRecord,
    dispatch: DispatchIntent,
  ): Promise<AdmissionResult>;
}
export interface WorkflowCatalog {
  readonly scope: TenantScope;
  getVersion(id: string): Promise<WorkflowVersion | undefined>;
  publish(version: WorkflowVersion): Promise<WorkflowVersion>;
}
/** Immutable content, scoped per tenant. Existing identities cannot change bytes. */
export interface ArtifactStore {
  readonly scope: TenantScope;
  put(bytes: Uint8Array): Promise<ArtifactIdentity>;
  get(identity: ArtifactIdentity): Promise<Uint8Array | undefined>;
}
