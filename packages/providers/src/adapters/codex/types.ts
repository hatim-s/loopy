import type {
  JsonObject,
  JsonValue,
  ProviderInstallationV1,
  UsageRecordV1,
} from "@loopy/contracts";

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export type CodexCommandOptions = {
  prompt?: string;
  model?: string;
  cwd?: string;
  sandbox?: CodexSandbox;
  outputSchema?: string | JsonObject;
  resumeSessionId?: string;
  executable?: string;
};

export type ProviderEventKind =
  | "assistant"
  | "user"
  | "tool"
  | "tool_result"
  | "usage"
  | "result"
  | "session"
  | "subagent_started"
  | "subagent_ended"
  | "diagnostic";

/** Provider events intentionally contain visible content only; reasoning fields are never copied. */
export type CodexEvent = {
  kind: ProviderEventKind;
  type: string;
  provider: "codex";
  sessionId?: string;
  parentSessionId?: string;
  toolCallId?: string;
  parentId?: string;
  role?: "assistant" | "user" | "system";
  text?: string;
  tool?: string;
  input?: JsonValue;
  output?: JsonValue;
  usage?: UsageRecordV1;
  result?: { status: "succeeded" | "failed" | "cancelled"; summary?: string; error?: string };
  diagnostic?: {
    code: "unknown_event" | "malformed_event" | "redacted_event";
    message: string;
    raw?: string;
  };
  /** Bounded provider metadata useful for correlation, never a hidden reasoning transcript. */
  metadata?: JsonObject;
};

export type CodexStreamContext = {
  sessionId?: string;
  parentSessionId?: string;
  maxDiagnosticBytes?: number;
};

export type CodexProbeResult = {
  installation: ProviderInstallationV1;
  versionOutput: string;
  pathOutput?: string;
};

export type CodexProbeRunner = (command: readonly string[]) => Promise<{
  exitCode: number;
  stdout: string;
  stderr?: string;
}>;

export type CodexHistoricalImport = {
  provider: "codex";
  format: "codex-jsonl";
  formatVersion: "codex-cli-0.146.0" | `codex-cli-${string}`;
  unstable: true;
  provenance: {
    source: string;
    provider: "codex";
    providerVersion: string;
    importedAt: string;
  };
  sessionId?: string;
  parentSessionId?: string;
  events: CodexEvent[];
  diagnostics: string[];
};

export type CodexCapabilitiesOptions = {
  version?: string;
  nestedSubagentVisibility?: boolean;
};
