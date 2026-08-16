import type { ProviderCapabilities, ProviderInstallation, TraceEvent } from "@loopy/contracts";

export const OPENCODE_PROVIDER = "opencode" as const;
export const OPENCODE_EXPORT_FORMAT_V1 = "opencode.export.v1" as const;

export type OpenCodeCommand = {
  executable: string;
  args: string[];
};

export type OpenCodeRunRequest = {
  prompt: string;
  model?: string;
  agent?: string;
  sessionId?: string;
  fork?: boolean;
  dir?: string;
  variant?: string;
  /** `--auto` is deliberately opt-in because it can approve side effects. */
  auto?: boolean;
  allowAuto?: boolean;
};

export type OpenCodeExportRequest = {
  sessionId: string;
  outputPath?: string;
};

export type OpenCodeSessionSummary = {
  id: string;
  title?: string;
  directory?: string;
  updatedAt?: string;
  parentId?: string;
};

export type ProviderAdapterContext = {
  runId?: string;
  nodeId?: string;
  attemptId?: string;
  sessionId?: string;
  sequence?: number;
  occurredAt?: string;
  monotonicOffsetMs?: number;
  source?: string;
  providerVersion?: string;
};

export type AdapterDiagnostic = {
  code:
    | "malformed_event"
    | "unknown_event"
    | "unsupported_version"
    | "lossy_event"
    | "missing_cli"
    | "invalid_option"
    | "unsafe_argument";
  message: string;
  source?: string;
  rawType?: string;
};

export type OpenCodeNormalizedEvent = TraceEvent;

export type OpenCodeNormalizationResult = {
  events: OpenCodeNormalizedEvent[];
  diagnostics: AdapterDiagnostic[];
};

export type OpenCodeImportedSession = {
  schemaVersion: typeof OPENCODE_EXPORT_FORMAT_V1;
  provider: typeof OPENCODE_PROVIDER;
  sessionId: string;
  providerVersion?: string;
  sourceFormat: "official-export" | "run-json";
  events: TraceEvent[];
  diagnostics: AdapterDiagnostic[];
  provenance: {
    source?: string;
    format: typeof OPENCODE_EXPORT_FORMAT_V1 | "run-json";
    version?: string;
    diagnostics: AdapterDiagnostic[];
  };
};

export type OpenCodeProbeResult = ProviderInstallation & {
  capabilities: ProviderCapabilities;
};
