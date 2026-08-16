import type { TraceEvent } from "@loopy/contracts";
import type { AdapterDiagnostic, PiNormalizationResult, ProviderAdapterContext } from "./types.js";
import { diagnostic, eventBase, jsonValue, parseJsonLine, safeString, uuidFrom } from "./util.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const result = value
      .map(record)
      .filter((part) => {
        const kind = safeString(part.type)?.toLowerCase() ?? "";
        return !kind.includes("thinking") && !kind.includes("reason") && !kind.includes("chain");
      })
      .map((part) => safeString(part.text))
      .filter((part): part is string => Boolean(part))
      .join("");
    return result || undefined;
  }
  return undefined;
}
function usage(value: unknown): Record<string, number> | undefined {
  const item = record(value);
  const cost = record(item.cost);
  const input = typeof item.input === "number" ? item.input : undefined;
  const output = typeof item.output === "number" ? item.output : undefined;
  const total =
    typeof item.totalTokens === "number"
      ? item.totalTokens
      : input !== undefined || output !== undefined
        ? (input ?? 0) + (output ?? 0)
        : undefined;
  const costUsd = typeof cost.total === "number" ? cost.total : undefined;
  if (input === undefined && output === undefined && total === undefined && costUsd === undefined)
    return undefined;
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

export function normalizePiEvent(
  raw: unknown,
  context: ProviderAdapterContext = {},
): { event?: TraceEvent; diagnostics: AdapterDiagnostic[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { diagnostics: [diagnostic("malformed_event", "Pi event must be a JSON object.")] };
  const value = raw as Record<string, unknown>;
  const type = safeString(value.type)?.toLowerCase();
  if (!type) return { diagnostics: [diagnostic("malformed_event", "Pi event has no type.")] };
  const session =
    safeString(value.sessionId) ??
    safeString(value.sessionID) ??
    safeString(value.id) ??
    context.sessionId ??
    "pi-session-unknown";
  const payload = record(value.message);
  const base = (
    eventType: TraceEvent["type"],
    body: Record<string, unknown>,
    toolCallId?: string,
  ): TraceEvent =>
    ({
      ...eventBase(context, eventType, session),
      ...(toolCallId ? { toolCallId: uuidFrom(toolCallId) } : {}),
      type: eventType,
      payload: body,
    }) as TraceEvent;
  if (type === "session" || type === "session_start" || type === "session_started") {
    const parent = safeString(value.parentSessionId) ?? safeString(value.parentSessionID);
    return {
      event: base("provider.session_started", parent ? { parentSessionId: parent } : {}),
      diagnostics: [],
    };
  }
  if (type === "message_start") {
    const role = safeString(payload.role);
    const content = text(payload.content);
    if (!content || (role !== "user" && role !== "assistant" && role !== "system"))
      return {
        diagnostics: [
          diagnostic("malformed_event", "Pi message_start has no supported visible message.", type),
        ],
      };
    return { event: base("provider.message", { role, content }), diagnostics: [] };
  }
  if (type === "message_update") {
    const update = record(value.assistantMessageEvent);
    const updateType = safeString(update.type)?.toLowerCase();
    if (updateType?.includes("thinking") || updateType?.includes("reason"))
      return {
        diagnostics: [
          diagnostic("lossy_event", "Pi hidden reasoning content was intentionally omitted.", type),
        ],
      };
    const content = safeString(update.delta) ?? text(update.content);
    if (!content)
      return {
        diagnostics: [
          diagnostic("lossy_event", "Pi message update had no visible text delta.", type),
        ],
      };
    return { event: base("provider.message", { role: "assistant", content }), diagnostics: [] };
  }
  if (type === "message_end") {
    const content = text(payload.content);
    const events: TraceEvent[] = [];
    if (content) events.push(base("provider.message", { role: "assistant", content }));
    const counters = usage(payload.usage);
    if (counters) events.push(base("provider.usage", { usage: counters }));
    // Keep the single-event normalizer predictable; usage is represented on the
    // message only when callers consume stream normalization below.
    return {
      event: events[0],
      diagnostics:
        counters && events.length === 0
          ? [diagnostic("lossy_event", "Pi usage was present without visible message text.", type)]
          : [],
    };
  }
  if (type === "tool_execution_start") {
    const callId =
      safeString(value.toolCallId) ??
      safeString(value.callId) ??
      `${session}:tool:${context.sequence ?? 0}`;
    const tool = safeString(value.toolName) ?? "unknown-tool";
    return {
      event: base("tool.requested", { tool, input: jsonValue(value.args ?? {}) }, callId),
      diagnostics: [],
    };
  }
  if (type === "tool_execution_end") {
    const callId =
      safeString(value.toolCallId) ??
      safeString(value.callId) ??
      `${session}:tool:${context.sequence ?? 0}`;
    const tool = safeString(value.toolName) ?? "unknown-tool";
    if (value.isError === true)
      return {
        event: base(
          "tool.denied",
          { tool, reason: text(value.result) ?? "Pi tool execution failed." },
          callId,
        ),
        diagnostics: [],
      };
    return {
      event: base(
        "tool.completed",
        { output: jsonValue(value.result ?? value.output ?? "") },
        callId,
      ),
      diagnostics: [],
    };
  }
  if (type === "agent_end" || type === "session_end" || type === "session_ended")
    return { event: base("provider.session_ended", { status: "succeeded" }), diagnostics: [] };
  if (type === "error" || type === "agent_error")
    return {
      event: base("provider.session_ended", {
        status: "failed",
        error: safeString(value.error) ?? safeString(value.message) ?? "Pi session failed.",
      }),
      diagnostics: [],
    };
  if (type.includes("thinking") || type.includes("reason"))
    return {
      diagnostics: [
        diagnostic("lossy_event", "Pi hidden reasoning content was intentionally omitted.", type),
      ],
    };
  if (type === "turn_end") {
    const counters = usage(value.usage ?? payload.usage);
    return counters
      ? { event: base("provider.usage", { usage: counters }), diagnostics: [] }
      : {
          diagnostics: [
            diagnostic("lossy_event", "Pi turn_end contained no recognized usage counters.", type),
          ],
        };
  }
  return {
    diagnostics: [diagnostic("unknown_event", `Unsupported Pi event type: ${type}.`, type)],
  };
}

export async function normalizePiJsonLines(
  lines: Iterable<string> | AsyncIterable<string>,
  context: ProviderAdapterContext = {},
): Promise<PiNormalizationResult> {
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
    const normalized = normalizePiEvent(parsed.value, { ...context, sequence });
    diagnostics.push(...normalized.diagnostics);
    if (normalized.event) {
      events.push(normalized.event);
      sequence += 1;
    }
    // Pi places usage on message_end. Preserve it as a separate canonical
    // event so stream consumers do not have to inspect provider payloads.
    if (parsed.value.type === "message_end") {
      const messageUsage = record(record(parsed.value.message).usage);
      if (Object.keys(messageUsage).length > 0) {
        const usageEvent = normalizePiEvent(
          {
            type: "turn_end",
            sessionId: parsed.value.sessionId ?? parsed.value.sessionID,
            usage: messageUsage,
          },
          { ...context, sequence },
        );
        diagnostics.push(...usageEvent.diagnostics);
        if (usageEvent.event) {
          events.push(usageEvent.event);
          sequence += 1;
        }
      }
    }
  }
  return { events, diagnostics };
}

export const normalizePiStream = normalizePiJsonLines;
