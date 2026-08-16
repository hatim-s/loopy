import type { ProviderCapabilities, ProviderInstallation, TraceEvent } from "@loopy/contracts";

export const PI_PROVIDER = "pi" as const;
export const PI_SESSION_FORMAT_V3 = 3 as const;
export const PI_IMPORT_FORMAT_V1 = "pi.session.v3" as const;

export type PiCommand = { executable: string; args: string[] };
export type PiApproval = "approve" | "no-approve";
export type PiRunRequest = {
  prompt: string;
  provider?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  sessionId?: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  noTools?: boolean;
  noExtensions?: boolean;
  noSkills?: boolean;
  noContextFiles?: boolean;
  approval?: PiApproval;
  offline?: boolean;
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

export type PiNormalizationResult = { events: TraceEvent[]; diagnostics: AdapterDiagnostic[] };
export type PiImportedSession = {
  schemaVersion: typeof PI_IMPORT_FORMAT_V1;
  provider: typeof PI_PROVIDER;
  sessionId: string;
  providerVersion?: string;
  sourceFormat: "session-jsonl" | "run-json";
  sessionFileVersion: number;
  events: TraceEvent[];
  diagnostics: AdapterDiagnostic[];
  provenance: {
    source?: string;
    format: typeof PI_IMPORT_FORMAT_V1;
    version: number;
    providerVersion?: string;
  };
};
export type PiProbeResult = ProviderInstallation & { capabilities: ProviderCapabilities };
