import type { JsonValue, UsageRecordV1 } from "@loopy/contracts";
import type { CodexEvent, CodexStreamContext } from "./types.js";

const DEFAULT_DIAGNOSTIC_BYTES = 4_096;
const HIDDEN_KEYS = new Set([
  "analysis",
  "chain_of_thought",
  "chainOfThought",
  "thinking",
  "thought",
  "reasoning",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const object = record(value);
  if (!object) return undefined;
  if (typeof object.text === "string") return object.text;
  if (typeof object.content === "string") return object.content;
  return undefined;
}

function visibleText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.flatMap((part) => {
      const partRecord = record(part);
      if (partRecord && [...HIDDEN_KEYS].some((key) => key in partRecord)) return [];
      return visibleText(part) ? [visibleText(part) as string] : [];
    });
    return parts.length > 0 ? parts.join("") : undefined;
  }
  const object = record(value);
  if (!object) return undefined;
  if ([...HIDDEN_KEYS].some((key) => key in object)) return undefined;
  return text(object);
}

function boundedRaw(value: unknown, maxBytes: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  return serialized.length <= maxBytes
    ? serialized
    : `${serialized.slice(0, Math.max(0, maxBytes - 1))}…`;
}

function diagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(diagnosticValue);
  const object = record(value);
  if (!object) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    if (HIDDEN_KEYS.has(key) || /(?:reasoning|thinking|analysis|chain.of.thought)/i.test(key))
      continue;
    result[key] = diagnosticValue(item);
  }
  return result;
}

function sessionId(event: Record<string, unknown>, fallback?: string): string | undefined {
  for (const key of [
    "session_id",
    "sessionId",
    "thread_id",
    "threadId",
    "conversation_id",
    "conversationId",
    "agent_id",
    "agentId",
    "subagent_id",
    "subagentId",
  ]) {
    if (typeof event[key] === "string" && event[key].length > 0) return event[key] as string;
  }
  const item = record(event.item);
  for (const key of ["session_id", "sessionId", "thread_id", "threadId"]) {
    if (item && typeof item[key] === "string" && item[key].length > 0) return item[key] as string;
  }
  return fallback;
}

function parentSessionId(event: Record<string, unknown>, fallback?: string): string | undefined {
  for (const key of [
    "parent_session_id",
    "parentSessionId",
    "parent_thread_id",
    "parentThreadId",
  ]) {
    if (typeof event[key] === "string" && event[key].length > 0) return event[key] as string;
  }
  return fallback;
}

function usage(value: unknown): UsageRecordV1 | undefined {
  const input = record(value);
  if (!input) return undefined;
  const number = (...keys: string[]): number | undefined => {
    for (const key of keys)
      if (typeof input[key] === "number" && Number.isFinite(input[key]))
        return input[key] as number;
    return undefined;
  };
  const result: UsageRecordV1 = {
    ...(number("input_tokens", "inputTokens", "prompt_tokens", "promptTokens") !== undefined
      ? { inputTokens: number("input_tokens", "inputTokens", "prompt_tokens", "promptTokens") }
      : {}),
    ...(number("output_tokens", "outputTokens", "completion_tokens", "completionTokens") !==
    undefined
      ? {
          outputTokens: number(
            "output_tokens",
            "outputTokens",
            "completion_tokens",
            "completionTokens",
          ),
        }
      : {}),
    ...(number("total_tokens", "totalTokens") !== undefined
      ? { totalTokens: number("total_tokens", "totalTokens") }
      : {}),
    ...(number("cost_usd", "costUsd", "cost") !== undefined
      ? { costUsd: number("cost_usd", "costUsd", "cost") }
      : {}),
    ...(number("duration_ms", "durationMs") !== undefined
      ? { durationMs: number("duration_ms", "durationMs") }
      : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function diagnostic(
  code: "unknown_event" | "malformed_event" | "redacted_event",
  message: string,
  raw: unknown,
  context: CodexStreamContext,
): CodexEvent {
  return {
    kind: "diagnostic",
    type: "provider.diagnostic",
    provider: "codex",
    diagnostic: {
      code,
      message,
      ...(raw === undefined
        ? {}
        : {
            raw: boundedRaw(
              diagnosticValue(raw),
              context.maxDiagnosticBytes ?? DEFAULT_DIAGNOSTIC_BYTES,
            ),
          }),
    },
  };
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const values = value.map(jsonValue);
    return values.every((item) => item !== undefined) ? (values as JsonValue[]) : undefined;
  }
  const object = record(value);
  if (!object) return undefined;
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(object)) {
    if (HIDDEN_KEYS.has(key)) continue;
    const normalized = jsonValue(item);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

/** Normalize one Codex JSONL object into visible Loopy provider events. */
export function normalizeCodexEvent(
  input: unknown,
  context: CodexStreamContext = {},
): CodexEvent[] {
  const event = record(input);
  if (!event || typeof event.type !== "string")
    return [diagnostic("malformed_event", "Codex record has no string type", input, context)];
  const type = event.type;
  if (HIDDEN_KEYS.has(type) || /(?:reasoning|thinking|analysis|chain.of.thought)/i.test(type)) {
    return [
      diagnostic(
        "redacted_event",
        "Provider reasoning content is intentionally not imported",
        undefined,
        context,
      ),
    ];
  }
  const sid = sessionId(event, context.sessionId);
  const parent = parentSessionId(event, context.parentSessionId);
  const item = record(event.item);
  const itemType = typeof item?.type === "string" ? item.type : "";
  if (/(?:reasoning|thinking|analysis|chain.of.thought)/i.test(itemType)) {
    return [
      diagnostic(
        "redacted_event",
        "Provider reasoning content is intentionally not imported",
        undefined,
        context,
      ),
    ];
  }
  const common = {
    provider: "codex" as const,
    ...(sid ? { sessionId: sid } : {}),
    ...(parent ? { parentSessionId: parent } : {}),
  };

  if (
    type === "thread.started" ||
    type === "session.started" ||
    type === "thread.resumed" ||
    type === "session.resumed"
  ) {
    return [
      {
        kind: "session",
        type: "provider.session_started",
        ...common,
        ...(parent ? { parentSessionId: parent } : {}),
      },
    ];
  }
  if (type === "thread.completed" || type === "session.completed" || type === "session.ended") {
    const status =
      event.status === "cancelled" || event.status === "canceled"
        ? "cancelled"
        : event.status === "failed" || event.error
          ? "failed"
          : "succeeded";
    return [
      {
        kind: "result",
        type: "provider.session_ended",
        ...common,
        result: { status, ...(typeof event.error === "string" ? { error: event.error } : {}) },
      },
    ];
  }
  if (
    type === "turn.completed" ||
    type === "response.completed" ||
    type === "turn.failed" ||
    type === "turn.cancelled"
  ) {
    const usageValue = usage(event.usage);
    const resultEvent: CodexEvent = {
      kind: "result",
      type: "provider.result",
      ...common,
      result: {
        status: type.endsWith("cancelled")
          ? "cancelled"
          : type.endsWith("failed") || event.error
            ? "failed"
            : "succeeded",
        ...(typeof event.error === "string" ? { error: event.error } : {}),
        ...(typeof event.message === "string" ? { summary: event.message } : {}),
      },
    };
    return usageValue
      ? [{ kind: "usage", type: "provider.usage", ...common, usage: usageValue }, resultEvent]
      : [resultEvent];
  }
  if (
    type === "response.output_text.delta" ||
    type === "output_text.delta" ||
    type === "assistant.delta"
  ) {
    const content = visibleText(event.delta ?? event.text ?? event.content);
    return content === undefined
      ? []
      : [
          {
            kind: "assistant",
            type: "provider.message",
            ...common,
            role: "assistant",
            text: content,
          },
        ];
  }
  if (
    type === "message" ||
    type === "response.message" ||
    type === "assistant.message" ||
    type === "user.message"
  ) {
    const role = event.role === "user" ? "user" : event.role === "system" ? "system" : "assistant";
    const content = visibleText(event.content ?? event.text ?? event.message);
    return content === undefined
      ? []
      : [
          {
            kind: role === "user" ? "user" : "assistant",
            type: "provider.message",
            ...common,
            role,
            text: content,
          },
        ];
  }
  if (
    item &&
    (itemType === "agent_message" || itemType === "assistant_message" || itemType === "message")
  ) {
    const content = visibleText(item.text ?? item.content ?? item.message);
    return content === undefined
      ? []
      : [
          {
            kind: "assistant",
            type: "provider.message",
            ...common,
            role: "assistant",
            text: content,
          },
        ];
  }
  if (
    item &&
    (itemType === "command_execution" ||
      itemType === "tool_call" ||
      itemType === "mcp_tool_call" ||
      itemType === "function_call")
  ) {
    const callId =
      typeof item.id === "string"
        ? item.id
        : typeof item.call_id === "string"
          ? item.call_id
          : undefined;
    const tool =
      typeof item.tool === "string"
        ? item.tool
        : itemType === "command_execution"
          ? "command"
          : typeof item.name === "string"
            ? item.name
            : itemType;
    const command = item.command ?? item.input ?? item.arguments;
    const output = item.aggregated_output ?? item.output ?? item.result;
    const isComplete = type.endsWith("completed") || type.endsWith("result");
    const value = isComplete ? jsonValue(output) : undefined;
    const input = jsonValue(command);
    if (isComplete)
      return [
        {
          kind: "tool_result",
          type: "tool.completed",
          ...common,
          toolCallId: callId,
          tool,
          ...(value !== undefined ? { output: value } : {}),
          metadata: { ...(typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {}) },
        },
      ];
    return [
      {
        kind: "tool",
        type: "tool.requested",
        ...common,
        toolCallId: callId,
        tool,
        ...(input !== undefined ? { input } : {}),
      },
    ];
  }
  if (type === "usage" || type === "response.usage") {
    const usageValue = usage(event.usage ?? event);
    return usageValue
      ? [{ kind: "usage", type: "provider.usage", ...common, usage: usageValue }]
      : [
          diagnostic(
            "malformed_event",
            "Codex usage event has no recognized counters",
            input,
            context,
          ),
        ];
  }
  if (type.startsWith("subagent.") || itemType === "subagent" || itemType === "agent_spawn") {
    const child =
      typeof event.child_session_id === "string"
        ? event.child_session_id
        : typeof item?.session_id === "string"
          ? item.session_id
          : sid;
    return [
      {
        kind: /(?:end|complete|stop|exit)/i.test(type) ? "subagent_ended" : "subagent_started",
        type: "provider.subagent",
        ...common,
        ...(child ? { sessionId: child } : {}),
        ...(child ? { parentId: child } : {}),
        ...(parent ? { parentSessionId: parent } : {}),
        ...(visibleText(event.text ?? item?.text)
          ? { text: visibleText(event.text ?? item?.text) }
          : {}),
      },
    ];
  }
  return [diagnostic("unknown_event", `Unknown Codex event type ${type}`, input, context)];
}

export function parseCodexJsonLine(line: string, context: CodexStreamContext = {}): CodexEvent[] {
  try {
    return normalizeCodexEvent(JSON.parse(line) as unknown, context);
  } catch {
    return [diagnostic("malformed_event", "Codex JSONL line is not valid JSON", line, context)];
  }
}

export function normalizeCodexStream(
  input: string | Iterable<string>,
  context: CodexStreamContext = {},
): CodexEvent[] {
  const lines = typeof input === "string" ? input.split(/\r?\n/) : input;
  const events: CodexEvent[] = [];
  for (const line of lines) if (line.trim()) events.push(...parseCodexJsonLine(line, context));
  return events;
}

export const parseCodexStream = normalizeCodexStream;
export const normalizeCodexLine = parseCodexJsonLine;
export const parseCodexEvent = normalizeCodexEvent;

export async function normalizeCodexAsyncStream(
  input: AsyncIterable<string>,
  context: CodexStreamContext = {},
): Promise<CodexEvent[]> {
  const events: CodexEvent[] = [];
  for await (const line of input)
    if (line.trim()) events.push(...parseCodexJsonLine(line, context));
  return events;
}
