import type { AdmissionStore, TenantScope, WorkflowCatalog } from "../application/ports.js";
import type { Json, RunRecord } from "../core/model.js";
import type {
  Capabilities,
  Capability,
  InspectResponse,
  ProtocolError,
  RunRequest,
  RunResponse,
} from "../protocol/index.js";
import { prepareRun } from "../runtime/prepare.js";
import type { DurableRunRepository } from "../runtime/transition-store.js";
import type { DurableDriver } from "./dispatch.js";

/** A trusted token verifier and membership lookup supply this value, never a request body. */
export type VerifiedPrincipal = {
  subject: string;
  tenantId: string;
  operations: readonly Capability[];
};
export type Authenticator = (request: Request) => Promise<VerifiedPrincipal | undefined>;
export type TenantControl = {
  catalog: WorkflowCatalog;
  admission: AdmissionStore;
  runs: DurableRunRepository;
};
export class ControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: ProtocolError["code"],
    message: string,
  ) {
    super(message);
  }
}

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function fingerprint(value: Json): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class HostedControl {
  constructor(
    private readonly bind: (scope: TenantScope) => TenantControl,
    private readonly driver: DurableDriver,
    readonly capabilities: Capabilities,
  ) {}

  private authorize(principal: VerifiedPrincipal, operation: Capability): TenantControl {
    if (!principal.subject || !principal.tenantId)
      throw new ControlError(401, "unauthorized", "Authentication required");
    if (!principal.operations.includes(operation))
      throw new ControlError(403, "forbidden", "Operation not allowed");
    if (!this.capabilities.operations.includes(operation))
      throw new ControlError(501, "unsupported", "Operation unavailable");
    const services = this.bind({ tenantId: principal.tenantId });
    for (const service of [services.catalog, services.admission, services.runs]) {
      if (service.scope.tenantId !== principal.tenantId)
        throw new Error("Control repository tenant mismatch");
    }
    return services;
  }

  async admit(principal: VerifiedPrincipal, request: RunRequest): Promise<RunResponse> {
    const services = this.authorize(principal, "run");
    const version = await services.catalog.getVersion(request.versionId);
    if (!version) throw new ControlError(404, "not-found", "Workflow version not found");
    if (
      version.runtime.build !== this.capabilities.runtime.build ||
      version.runtime.graphSchema !== this.capabilities.runtime.graphSchema
    )
      throw new ControlError(409, "conflict", "Workflow runtime is unavailable");
    let run: RunRecord;
    try {
      run = await prepareRun(version.workflow, request.input, {
        workspace: { kind: "managed", id: crypto.randomUUID() },
        mode: "sandbox",
      });
    } catch {
      throw new ControlError(400, "invalid-input", "Workflow input failed preflight");
    }
    const result = await services.admission.admit(
      {
        versionId: version.id,
        input: run.input,
        idempotencyKey: request.idempotencyKey,
        fingerprint: await fingerprint({ versionId: version.id, input: run.input }),
      },
      run,
      { id: crypto.randomUUID(), runId: run.id, runtime: version.runtime },
    );
    if (result.state === "conflict")
      throw new ControlError(409, "conflict", "Idempotency key already used for another request");
    return result;
  }

  async inspect(principal: VerifiedPrincipal, runId: string): Promise<InspectResponse> {
    const state = await this.authorize(principal, "read").runs.read(runId);
    if (!state) throw new ControlError(404, "not-found", "Run not found");
    return { run: state.run, attempts: state.attempts };
  }

  async cancel(principal: VerifiedPrincipal, runId: string): Promise<void> {
    const services = this.authorize(principal, "cancel");
    if (!(await services.runs.read(runId)))
      throw new ControlError(404, "not-found", "Run not found");
    await services.runs.requestCancel(runId);
    // Cancellation is durable before the host is contacted. The sweep can retry wakeup.
    try {
      await this.driver.cancel(services.runs.scope, runId);
    } catch {}
  }
}
