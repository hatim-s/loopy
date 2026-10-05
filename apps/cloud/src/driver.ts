import type {
  RuntimeIdentity,
  TenantScope,
} from "../../../packages/loopy/src/application/ports.js";
import type { DurableDriver } from "../../../packages/loopy/src/cloud/dispatch.js";
import type { CloudEnv } from "./types.js";

export class CloudflareDriver implements DurableDriver {
  constructor(private readonly env: CloudEnv) {}
  private async wake(scope: TenantScope, runId: string, runtime?: RuntimeIdentity): Promise<void> {
    const id = this.env.COORDINATORS.idFromName(JSON.stringify([scope.tenantId, runId]));
    const response = await this.env.COORDINATORS.get(id).fetch(
      "https://coordinator.internal/wake",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: scope.tenantId, runId, ...(runtime ? { runtime } : {}) }),
      },
    );
    if (!response.ok) throw new Error("Coordinator wakeup failed");
  }
  ensureStarted(scope: TenantScope, runId: string, runtime: RuntimeIdentity): Promise<void> {
    return this.wake(scope, runId, runtime);
  }
  cancel(scope: TenantScope, runId: string): Promise<void> {
    return this.wake(scope, runId);
  }
}
