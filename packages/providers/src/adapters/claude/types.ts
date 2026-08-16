import type { JsonObject, JsonValue, UsageRecordV1 } from "@loopy/contracts";

export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk";

export type ClaudeCommandOptions = {
  prompt: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: ClaudePermissionMode;
  sessionId?: string;
  resumeSessionId?: string;
  forwardSubagentText?: boolean;
  executable?: string;
};

export type ClaudeEvent = {
  kind:
    | "assistant"
    | "user"
    | "tool"
    | "tool_result"
    | "usage"
    | "result"
    | "session"
    | "subagent"
    | "diagnostic";
  type: string;
  provider: "claude";
  sessionId?: string;
  parentSessionId?: string;
  parentId?: string;
  toolCallId?: string;
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
  metadata?: JsonObject;
};

export type ClaudeStreamContext = {
  sessionId?: string;
  parentSessionId?: string;
  maxDiagnosticBytes?: number;
};

export type ClaudeProbeRunner = (
  command: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;

export type ClaudeHistoricalImport = {
  provider: "claude";
  format: "claude-stream-json";
  formatVersion: `claude-code-${string}`;
  unstable: true;
  provenance: { source: string; provider: "claude"; providerVersion: string; importedAt: string };
  sessionId?: string;
  parentSessionId?: string;
  events: ClaudeEvent[];
  diagnostics: string[];
};
