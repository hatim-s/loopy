import type { TraceEvent } from "@loopy/contracts";
import type {
  AdapterDiagnostic,
  OpenCodeNormalizationResult,
  ProviderAdapterContext,
} from "./types.js";
import { diagnostic, eventBase, jsonValue, parseJsonLine, safeString, uuidFrom } from "./util.js";

function stringValue(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = safeString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function partOf(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.part && typeof raw.part === "object" && !Array.isArray(raw.part)
    ? (raw.part as Record<string, unknown>)
    : raw;
}

function sessionOf(
  raw: Record<string, unknown>,
  part: Record<string, unknown>,
  context: ProviderAdapterContext,
): string {
  return (
    stringValue(raw, "sessionID", "sessionId", "session_id") ??
    stringValue(part, "sessionID", "sessionId", "session_id") ??
    context.sessionId ??
    "opencode-session-unknown"
  );
}

function contentOf(part: Record<string, unknown>): string | undefined {
  const direct = safeString(part.text) ?? safeString(part.content) ?? safeString(part.message);
  if (direct) return direct;
  if (Array.isArray(part.content)) {
    const text = part.content
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => safeString(item.text))
      .filter((item): item is string => Boolean(item))
      .join("");
    if (text) return text;
  }
  return undefined;
}

function usageOf(part: Record<string, unknown>): Record<string, number> | undefined {
  const tokens =
    part.tokens && typeof part.tokens === "object" ? (part.tokens as Record<string, unknown>) : {};
  const input = typeof tokens.input === "number" ? tokens.input : undefined;
  const output = typeof tokens.output === "number" ? tokens.output : undefined;
  const total =
    input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined;
  const cost = typeof part.cost === "number" ? part.cost : undefined;
  if (input === undefined && output === undefined && cost === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

function canonical(
  raw: Record<string, unknown>,
  context: ProviderAdapterContext,
): { event?: TraceEvent; diagnostics: AdapterDiagnostic[] } {
  const diagnostics: AdapterDiagnostic[] = [];
  const type = stringValue(raw, "type", "event")?.toLowerCase();
  if (!type) return { diagnostics: [diagnostic("malformed_event", "OpenCode event has no type.")] };
  const part = partOf(raw);
  const sessionId = sessionOf(raw, part, context);
  const base = (
    eventType: TraceEvent["type"],
    payload: Record<string, unknown>,
    toolCallId?: string,
  ): TraceEvent =>
    ({
      ...eventBase(context, eventType, sessionId),
      ...(toolCallId ? { toolCallId: uuidFrom(toolCallId) } : {}),
      type: eventType,
      payload,
    }) as TraceEvent;

  if (["session_start", "session_started", "step_start"].includes(type)) {
    const parent =
      stringValue(raw, "parentSessionID", "parentSessionId") ??
      stringValue(part, "parentSessionID", "parentSessionId");
    return {
      event: base("provider.session_started", parent ? { parentSessionId: parent } : {}),
      diagnostics,
    };
  }
  if (["text", "message", "assistant", "message_update"].includes(type)) {
    const partType = stringValue(part, "type")?.toLowerCase() ?? "";
    if (partType.includes("reason") || partType.includes("think") || partType.includes("chain")) {
      return {
        diagnostics: [
          diagnostic("lossy_event", "Hidden reasoning content was intentionally omitted.", type),
        ],
      };
    }
    const content = contentOf(part);
    if (!content)
      return {
        diagnostics: [
          diagnostic("malformed_event", "OpenCode message event has no visible text.", type),
        ],
      };
    return { event: base("provider.message", { role: "assistant", content }), diagnostics };
  }
  if (["tool_use", "tool", "tool_call"].includes(type)) {
    const tool = stringValue(part, "tool", "name") ?? "unknown-tool";
    const callId =
      stringValue(part, "callID", "callId", "id") ?? `${sessionId}:tool:${context.sequence ?? 0}`;
    const state =
      part.state && typeof part.state === "object" ? (part.state as Record<string, unknown>) : part;
    const status = stringValue(state, "status")?.toLowerCase();
    if (["completed", "complete", "success", "failed", "error"].includes(status ?? "")) {
      if (status === "failed" || status === "error" || state.error === true) {
        return {
          event: base(
            "tool.denied",
            { tool, reason: safeString(state.error) ?? "OpenCode tool failed." },
            callId,
          ),
          diagnostics,
        };
      }
      const output = state.output ?? state.result ?? "";
      const exitCode = typeof state.exitCode === "number" ? state.exitCode : undefined;
      return {
        event: base(
          "tool.completed",
          { output: jsonValue(output), ...(exitCode === undefined ? {} : { exitCode }) },
          callId,
        ),
        diagnostics,
      };
    }
    return {
      event: base(
        "tool.requested",
        { tool, input: jsonValue(state.input ?? part.input ?? {}) },
        callId,
      ),
      diagnostics,
    };
  }
  if (["step_finish", "usage", "token_usage"].includes(type)) {
    const usage = usageOf(part);
    if (!usage)
      return {
        diagnostics: [
          diagnostic("lossy_event", "OpenCode usage event contained no recognized counters.", type),
        ],
      };
    return { event: base("provider.usage", { usage }), diagnostics };
  }
  if (["session_end", "session_ended", "done", "complete"].includes(type)) {
    return { event: base("provider.session_ended", { status: "succeeded" }), diagnostics };
  }
  if (["error", "failure", "failed"].includes(type)) {
    const error = safeString(part.error) ?? safeString(part.message) ?? "OpenCode session failed.";
    return { event: base("provider.session_ended", { status: "failed", error }), diagnostics };
  }
  if (type.includes("reason") || type.includes("think") || type.includes("chain")) {
    return {
      diagnostics: [
        diagnostic("lossy_event", "Hidden reasoning content was intentionally omitted.", type),
      ],
    };
  }
  return {
    diagnostics: [diagnostic("unknown_event", `Unsupported OpenCode event type: ${type}.`, type)],
  };
}

export function normalizeOpenCodeEvent(
  raw: unknown,
  context: ProviderAdapterContext = {},
): { event?: TraceEvent; diagnostics: AdapterDiagnostic[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      diagnostics: [diagnostic("malformed_event", "OpenCode event must be a JSON object.")],
    };
  }
  return canonical(raw as Record<string, unknown>, context);
}

export function normalizeOpenCodeJsonLines(
  lines: Iterable<string> | AsyncIterable<string>,
  context: ProviderAdapterContext = {},
): Promise<OpenCodeNormalizationResult> {
  return (async () => {
    const events: TraceEvent[] = [];
    const diagnostics: AdapterDiagnostic[] = [];
    let sequence = context.sequence ?? 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseJsonLine(line);
      if (!parsed.value) {
        diagnostics.push(parsed.error as AdapterDiagnostic);
        continue;
      }
      const normalized = normalizeOpenCodeEvent(parsed.value, { ...context, sequence });
      diagnostics.push(...normalized.diagnostics);
      if (normalized.event) {
        events.push(normalized.event);
        sequence += 1;
      }
    }
    return { events, diagnostics };
  })();
}

export const normalizeOpenCodeStream = normalizeOpenCodeJsonLines;
