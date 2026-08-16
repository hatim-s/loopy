import type { Capability, JsonObject, JsonValue, UsageRecord } from "@loopy/contracts";

export type ProviderId = string;

export type CapabilityStatus = "supported" | "degraded" | "unavailable";

export type CapabilityAssessment = {
  status: CapabilityStatus;
  /** Required whenever a capability is degraded or unavailable. */
  reason?: string;
};

/** A deliberately honest, runtime-consumable capability report. */
export type CapabilityReport = {
  schemaVersion: "1";
  capabilities: Partial<Record<Capability | string, CapabilityAssessment>>;
  /** Convenience projections; these are derived from `capabilities`. */
  supported: string[];
  degraded: string[];
  unavailable: string[];
};

export type ProviderProbe = {
  provider: ProviderId;
  available: boolean;
  executable?: string;
  path?: string;
  version?: string;
  capabilities: CapabilityReport;
  diagnostic?: string;
  /** Missing optional CLIs are not configuration errors. */
  configurationError?: boolean;
};

export type SessionProvenance = {
  runId?: string;
  attemptId?: string;
  nodeId?: string;
  sessionId?: string;
  parentSessionId?: string;
  subagentId?: string;
  /** Historical import provenance is retained on imported provider events. */
  source?: string;
  format?: string;
  version?: string | number;
  diagnostics?: readonly JsonObject[];
};

export type ProviderModelMetadata = {
  model?: string;
  reasoning?: string;
  providerVersion?: string;
};

export type ProviderEventType =
  | "session_started"
  | "message"
  | "tool_call"
  | "tool_result"
  | "usage"
  | "subagent_started"
  | "subagent_ended"
  | "session_ended"
  | "error"
  | "unknown";

/** Provider output after provider-specific parsing has been normalized. */
export type ProviderEvent = {
  type: ProviderEventType;
  provider: ProviderId;
  occurredAt: string;
  provenance: SessionProvenance;
  payload?: JsonObject;
  model?: ProviderModelMetadata;
  usage?: UsageRecord;
  /** Preserve an unrecognized provider event without inventing semantics. */
  rawType?: string;
};

export type ProviderSession = {
  provider: ProviderId;
  sessionId: string;
  parentSessionId?: string;
  model?: ProviderModelMetadata;
};

export type ProviderRequest = {
  runId: string;
  attemptId: string;
  nodeId: string;
  input: JsonObject;
  prompt?: string;
  cwd?: string;
  model?: string;
  reasoning?: string;
  metadata?: JsonObject;
  /** Provider-neutral policy input. Adapters must map supported fields or fail honestly. */
  policy?: ProviderPolicy;
  signal?: AbortSignal;
};

export type ProviderPolicy = {
  tools?: {
    allow?: readonly string[];
    deny?: readonly string[];
    network?: "disabled" | "restricted" | "unrestricted";
  };
  workspace?: {
    workingDirectory?: string;
    writableRoots?: readonly string[];
  };
  approval?: {
    requiredBefore?: readonly string[];
    sideEffectLabels?: readonly string[];
    mode?: "approve" | "no-approve";
  };
  budget?: {
    maxTurns?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    timeoutMs?: number;
    maxOutputBytes?: number;
    maxOutputTokens?: number;
    maxOutputChars?: number;
  };
  sandbox?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxLineBytes?: number;
  maxLines?: number;
  limits?: {
    maxOutputBytes?: number;
    maxOutputTokens?: number;
    maxOutputChars?: number;
  };
  output?: { maxBytes?: number; maxTokens?: number; maxChars?: number };
};

export type ProviderResumeRequest = ProviderRequest & {
  sessionId: string;
  parentSessionId?: string;
};

export type ProviderRun = {
  session: Promise<ProviderSession>;
  events: AsyncIterable<ProviderEvent>;
  cancel(): Promise<void>;
};

export type HistoricalImportDescriptor = {
  id: string;
  label: string;
  formats: readonly string[];
  discover(): Promise<readonly string[]>;
  import(source: string): AsyncIterable<ProviderEvent>;
};

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly version: string;
  probe(): Promise<ProviderProbe>;
  capabilities(): CapabilityReport;
  start(request: ProviderRequest): Promise<ProviderRun>;
  resume?(request: ProviderResumeRequest): Promise<ProviderRun>;
  cancel?(run: ProviderRun): Promise<void>;
  readonly historicalImports: readonly HistoricalImportDescriptor[];
}

export type ProviderRegistry = {
  register(adapter: ProviderAdapter): ProviderRegistry;
  get(id: ProviderId): ProviderAdapter | undefined;
  all(): readonly ProviderAdapter[];
};

export function capabilityReport(values: Record<string, CapabilityAssessment>): CapabilityReport {
  const capabilities = { ...values };
  return {
    schemaVersion: "1",
    capabilities,
    supported: Object.entries(capabilities)
      .filter(([, value]) => value.status === "supported")
      .map(([key]) => key),
    degraded: Object.entries(capabilities)
      .filter(([, value]) => value.status === "degraded")
      .map(([key]) => key),
    unavailable: Object.entries(capabilities)
      .filter(([, value]) => value.status === "unavailable")
      .map(([key]) => key),
  };
}

export function assertHonestCapabilityReport(report: CapabilityReport): void {
  for (const [capability, assessment] of Object.entries(report.capabilities)) {
    if (!assessment) continue;
    if (assessment.status !== "supported" && !assessment.reason?.trim()) {
      throw new Error(`Capability '${capability}' is ${assessment.status} without a reason.`);
    }
  }
  const projection = (status: CapabilityStatus) =>
    Object.entries(report.capabilities)
      .filter(([, assessment]) => assessment?.status === status)
      .map(([key]) => key)
      .sort();
  for (const [label, actual, expected] of [
    ["supported", report.supported, projection("supported")],
    ["degraded", report.degraded, projection("degraded")],
    ["unavailable", report.unavailable, projection("unavailable")],
  ] as const) {
    if (JSON.stringify([...actual].sort()) !== JSON.stringify(expected))
      throw new Error(`Capability ${label} projection does not match its assessments.`);
  }
}

export function normalizeProviderEvent(
  event: ProviderEvent,
  defaults: { provider: ProviderId; provenance?: SessionProvenance; version?: string },
): ProviderEvent {
  const normalized: ProviderEvent = {
    ...event,
    provider: event.provider || defaults.provider,
    occurredAt: event.occurredAt || new Date().toISOString(),
    provenance: { ...defaults.provenance, ...event.provenance },
    model: event.model
      ? { ...event.model, providerVersion: event.model.providerVersion ?? defaults.version }
      : defaults.version
        ? { providerVersion: defaults.version }
        : undefined,
  };
  return normalized;
}

export function jsonObject(value: JsonValue | undefined): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}
