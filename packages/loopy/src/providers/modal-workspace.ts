import { type ModalClient, NotFoundError } from "modal";
import type { TenantScope } from "../application/ports.js";
import type { WorkspaceProvider } from "../runtime/durable-runner.js";
import type { WorkspaceGeneration } from "../runtime/remote-executor.js";
import type { SqliteDatabase } from "../storage/sqlite-driver.js";

export const modalWorkspaceSchema = [
  `CREATE TABLE loopy_modal_workspaces (
    tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    sandbox_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (tenant_id, run_id, workspace_id)
  )`,
] as const;

/** Trusted host only. Bind an already-created, dedicated sandbox; never inject Modal credentials. */
export class ModalWorkspaceProvider implements WorkspaceProvider {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly client: Pick<ModalClient, "sandboxes">,
    readonly scope: TenantScope,
  ) {}

  async bind(runId: string, workspaceId: string, sandboxId: string): Promise<WorkspaceGeneration> {
    if (!runId || !workspaceId || !sandboxId) throw new Error("Empty workspace binding identity");
    await this.db
      .prepare(
        `INSERT INTO loopy_modal_workspaces (tenant_id, run_id, workspace_id, sandbox_id)
       VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, run_id, workspace_id) DO NOTHING`,
      )
      .bind(this.scope.tenantId, runId, workspaceId, sandboxId)
      .run();
    const workspace = await this.provision(this.scope, runId, workspaceId);
    if (workspace.generation !== sandboxId) throw new Error("Workspace binding conflict");
    return workspace;
  }

  async provision(
    scope: TenantScope,
    runId: string,
    workspaceId: string,
  ): Promise<WorkspaceGeneration> {
    this.authorize(scope);
    const row = await this.db
      .prepare(
        "SELECT sandbox_id FROM loopy_modal_workspaces WHERE tenant_id=? AND run_id=? AND workspace_id=?",
      )
      .bind(scope.tenantId, runId, workspaceId)
      .first<{ sandbox_id: string }>();
    if (!row)
      throw new Error("Modal workspace must be assigned by the trusted host before admission");
    return { workspaceId, generation: row.sandbox_id };
  }

  async inspect(scope: TenantScope, workspace: WorkspaceGeneration): Promise<"available" | "lost"> {
    this.authorize(scope);
    const row = await this.db
      .prepare(
        "SELECT sandbox_id FROM loopy_modal_workspaces WHERE tenant_id=? AND workspace_id=? AND sandbox_id=?",
      )
      .bind(scope.tenantId, workspace.workspaceId, workspace.generation)
      .first<{ sandbox_id: string }>();
    if (!row) return "lost";
    try {
      const sandbox = await this.client.sandboxes.fromId(row.sandbox_id);
      return (await sandbox.poll()) === null ? "available" : "lost";
    } catch (error) {
      if (error instanceof NotFoundError) return "lost";
      throw error;
    }
  }

  private authorize(scope: TenantScope) {
    if (!scope.tenantId || scope.tenantId !== this.scope.tenantId)
      throw new Error("Workspace tenant mismatch");
  }
}
