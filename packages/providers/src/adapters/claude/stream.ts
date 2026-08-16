import type { JsonValue, UsageRecordV1 } from "@loopy/contracts";
import type { ClaudeEvent, ClaudeStreamContext } from "./types.js";

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
function bounded(value: unknown, max: number): string {
  let output: string;
  try {
    output = JSON.stringify(value) ?? String(value);
  } catch {
    output = String(value);
  }
  return output.length <= max ? output : `${output.slice(0, Math.max(0, max - 1))}…`;
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
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const object = record(value);
  if (!object || [...HIDDEN_KEYS].some((key) => key in object)) return undefined;
  if (typeof object.text === "string") return object.text;
  if (typeof object.content === "string") return object.content;
  if (Array.isArray(object.content)) return visibleText(object.content);
  return undefined;
}
function visibleText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const itemRecord = record(item);
      if (
        itemRecord?.type === "thinking" ||
        itemRecord?.type === "redacted_thinking" ||
        itemRecord?.type === "tool_use" ||
        itemRecord?.type === "tool_result"
      )
        continue;
      const part = text(item);
      if (part !== undefined) parts.push(part);
    }
    return parts.length ? parts.join("") : undefined;
  }
  return text(value);
}
function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const result = value.map(jsonValue);
    return result.every((item) => item !== undefined) ? (result as JsonValue[]) : undefined;
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
function sessionId(event: Record<string, unknown>, fallback?: string): string | undefined {
  for (const key of [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
    "agent_id",
    "agentId",
    "subagent_id",
    "subagentId",
  ])
    if (typeof event[key] === "string" && event[key]) return event[key] as string;
  return fallback;
}
function parentId(event: Record<string, unknown>, fallback?: string): string | undefined {
  for (const key of [
    "parent_session_id",
    "parentSessionId",
    "parent_tool_use_id",
    "parentToolUseId",
  ])
    if (typeof event[key] === "string" && event[key]) return event[key] as string;
  return fallback;
}
function usage(value: unknown): UsageRecordV1 | undefined {
  const object = record(value);
  if (!object) return undefined;
  const number = (...keys: string[]): number | undefined => {
    for (const key of keys)
      if (typeof object[key] === "number" && Number.isFinite(object[key]))
        return object[key] as number;
    return undefined;
  };
  const result: UsageRecordV1 = {
    ...(number("input_tokens", "inputTokens", "prompt_tokens") !== undefined
      ? { inputTokens: number("input_tokens", "inputTokens", "prompt_tokens") }
      : {}),
    ...(number("output_tokens", "outputTokens", "completion_tokens") !== undefined
      ? { outputTokens: number("output_tokens", "outputTokens", "completion_tokens") }
      : {}),
    ...(number("total_tokens", "totalTokens") !== undefined
      ? { totalTokens: number("total_tokens", "totalTokens") }
      : {}),
    ...(number("cost_usd", "costUsd", "total_cost_usd") !== undefined
      ? { costUsd: number("cost_usd", "costUsd", "total_cost_usd") }
      : {}),
    ...(number("duration_ms", "durationMs") !== undefined
      ? { durationMs: number("duration_ms", "durationMs") }
      : {}),
  };
  return Object.keys(result).length ? result : undefined;
}
function diagnostic(
  code: "unknown_event" | "malformed_event" | "redacted_event",
  message: string,
  raw: unknown,
  context: ClaudeStreamContext,
): ClaudeEvent {
  return {
    kind: "diagnostic",
    type: "provider.diagnostic",
    provider: "claude",
    diagnostic: {
      code,
      message,
      ...(raw === undefined
        ? {}
        : {
            raw: bounded(
              diagnosticValue(raw),
              context.maxDiagnosticBytes ?? DEFAULT_DIAGNOSTIC_BYTES,
            ),
          }),
    },
  };
}

/** Normalize one Claude Code stream-json record; hidden reasoning blocks are deliberately omitted. */
export function normalizeClaudeEvent(
  input: unknown,
  context: ClaudeStreamContext = {},
): ClaudeEvent[] {
  const event = record(input);
  if (!event || typeof event.type !== "string")
    return [diagnostic("malformed_event", "Claude record has no string type", input, context)];
  const type = event.type;
  if (HIDDEN_KEYS.has(type) || /(?:reasoning|thinking|analysis|chain.of.thought)/i.test(type))
    return [
      diagnostic(
        "redacted_event",
        "Provider reasoning content is intentionally not imported",
        undefined,
        context,
      ),
    ];
  const sid = sessionId(event, context.sessionId);
  const parent = parentId(event, context.parentSessionId);
  const common = {
    provider: "claude" as const,
    ...(sid ? { sessionId: sid } : {}),
    ...(parent ? { parentSessionId: parent } : {}),
  };
  const message = record(event.message);

  if (type === "system")
    return [
      {
        kind: "session",
        type: "provider.session_started",
        ...common,
        metadata: { ...(typeof event.subtype === "string" ? { subtype: event.subtype } : {}) },
      },
    ];
  if (type === "assistant" || type === "user") {
    const role = type === "user" ? "user" : "assistant";
    const content = visibleText(message?.content ?? event.content ?? event.text);
    const events: ClaudeEvent[] =
      content === undefined
        ? []
        : [{ kind: role, type: "provider.message", ...common, role, text: content }];
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      const item = record(block);
      if (!item) continue;
      if (item.type === "tool_use") {
        const callId = typeof item.id === "string" ? item.id : undefined;
        const input = jsonValue(item.input);
        events.push({
          kind: "tool",
          type: "tool.requested",
          ...common,
          toolCallId: callId,
          tool: typeof item.name === "string" ? item.name : "tool",
          ...(input !== undefined ? { input } : {}),
        });
      }
      if (item.type === "tool_result") {
        const output = jsonValue(item.content ?? item.output);
        events.push({
          kind: "tool_result",
          type: "tool.completed",
          ...common,
          toolCallId: typeof item.tool_use_id === "string" ? item.tool_use_id : undefined,
          tool: "tool",
          ...(output !== undefined ? { output } : {}),
          metadata: { ...(item.is_error === true ? { isError: true } : {}) },
        });
      }
    }
    const usageValue = usage(message?.usage);
    if (usageValue)
      events.push({ kind: "usage", type: "provider.usage", ...common, usage: usageValue });
    return events;
  }
  if (type === "content_block_delta") {
    const delta = record(event.delta);
    const content = visibleText(delta?.text ?? event.text);
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
  if (type === "content_block_start") {
    const block = record(event.content_block);
    if (block?.type === "tool_use") {
      const input = jsonValue(block.input);
      return [
        {
          kind: "tool",
          type: "tool.requested",
          ...common,
          toolCallId: typeof block.id === "string" ? block.id : undefined,
          tool: typeof block.name === "string" ? block.name : "tool",
          ...(input !== undefined ? { input } : {}),
        },
      ];
    }
    if (block?.type === "thinking" || block?.type === "redacted_thinking")
      return [
        diagnostic(
          "redacted_event",
          "Provider reasoning content is intentionally not imported",
          undefined,
          context,
        ),
      ];
    return [];
  }
  if (type === "tool_result") {
    const output = jsonValue(event.content ?? event.output);
    return [
      {
        kind: "tool_result",
        type: "tool.completed",
        ...common,
        toolCallId: typeof event.tool_use_id === "string" ? event.tool_use_id : undefined,
        tool: typeof event.tool_name === "string" ? event.tool_name : "tool",
        ...(output !== undefined ? { output } : {}),
        metadata: { ...(event.is_error === true ? { isError: true } : {}) },
      },
    ];
  }
  if (type === "result") {
    // Claude places total_cost_usd on the result envelope rather than under
    // result.usage in stream-json. Preserve that top-level accounting value.
    const usageValue = usage(event.usage ?? event);
    const failed =
      event.is_error === true || event.subtype === "error" || event.subtype === "failure";
    const output: ClaudeEvent = {
      kind: "result",
      type: "provider.result",
      ...common,
      result: {
        status: failed ? "failed" : "succeeded",
        ...(typeof event.result === "string" ? { summary: event.result } : {}),
        ...(typeof event.error === "string" ? { error: event.error } : {}),
      },
    };
    return usageValue
      ? [{ kind: "usage", type: "provider.usage", ...common, usage: usageValue }, output]
      : [output];
  }
  if (type.startsWith("subagent.") || typeof event.parent_tool_use_id === "string") {
    const content = visibleText(event.text ?? message?.content ?? event.content);
    return [
      {
        kind: /(?:end|complete|stop|exit)/i.test(type) ? "subagent_ended" : "subagent_started",
        type: "provider.subagent",
        ...common,
        ...(sid ? { parentId: sid } : {}),
        ...(content !== undefined ? { text: content } : {}),
      },
    ];
  }
  if (type === "error")
    return [
      {
        kind: "result",
        type: "provider.result",
        ...common,
        result: {
          status: "failed",
          error:
            typeof event.error === "string"
              ? event.error
              : typeof event.message === "string"
                ? event.message
                : "Claude provider error",
        },
      },
    ];
  return [diagnostic("unknown_event", `Unknown Claude stream event type ${type}`, input, context)];
}

export function parseClaudeJsonLine(
  line: string,
  context: ClaudeStreamContext = {},
): ClaudeEvent[] {
  try {
    return normalizeClaudeEvent(JSON.parse(line) as unknown, context);
  } catch {
    return [
      diagnostic("malformed_event", "Claude stream-json line is not valid JSON", line, context),
    ];
  }
}
export function normalizeClaudeStream(
  input: string | Iterable<string>,
  context: ClaudeStreamContext = {},
): ClaudeEvent[] {
  const lines = typeof input === "string" ? input.split(/\r?\n/) : input;
  const events: ClaudeEvent[] = [];
  for (const line of lines) if (line.trim()) events.push(...parseClaudeJsonLine(line, context));
  return events;
}
export const parseClaudeStream = normalizeClaudeStream;
export const normalizeClaudeLine = parseClaudeJsonLine;
export const parseClaudeEvent = normalizeClaudeEvent;

export async function normalizeClaudeAsyncStream(
  input: AsyncIterable<string>,
  context: ClaudeStreamContext = {},
): Promise<ClaudeEvent[]> {
  const events: ClaudeEvent[] = [];
  for await (const line of input)
    if (line.trim()) events.push(...parseClaudeJsonLine(line, context));
  return events;
}
