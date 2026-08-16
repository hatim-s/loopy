import { createHash, randomUUID } from "node:crypto";
import type { JsonValue, TraceEvent } from "@loopy/contracts";
import type { AdapterDiagnostic, ProviderAdapterContext } from "./types.js";

export function uuidFrom(value: string | undefined): string {
  if (!value) return randomUUID();
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
export function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
  return String(value);
}
export function eventBase(
  context: ProviderAdapterContext,
  type: TraceEvent["type"],
  sessionId?: string,
): Record<string, unknown> {
  return {
    schemaVersion: "1",
    id: randomUUID(),
    runId: uuidFrom(context.runId ?? "pi-run"),
    nodeId: uuidFrom(context.nodeId ?? "pi-node"),
    attemptId: uuidFrom(context.attemptId ?? "pi-attempt"),
    sequence: context.sequence ?? 0,
    occurredAt: context.occurredAt ?? new Date().toISOString(),
    monotonicOffsetMs: context.monotonicOffsetMs ?? 0,
    provider: "pi",
    sessionId: sessionId ?? context.sessionId ?? "pi-session-unknown",
    type,
    redaction: { status: "none", removedFields: [] },
  };
}
export function diagnostic(
  code: AdapterDiagnostic["code"],
  message: string,
  rawType?: string,
): AdapterDiagnostic {
  return { code, message, rawType };
}
export function parseJsonLine(line: string): {
  value?: Record<string, unknown>;
  error?: AdapterDiagnostic;
} {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { error: diagnostic("malformed_event", "Pi JSON event must be an object.") };
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: diagnostic("malformed_event", "Pi emitted malformed JSON.") };
  }
}
export function ensureArg(value: string, label: string): void {
  if (!value.trim()) throw new TypeError(`${label} must not be empty.`);
  if (value.includes("\0") || value.includes("\n") || value.includes("\r"))
    throw new TypeError(`${label} contains an unsafe control character.`);
}
export function listArg(values: string[] | undefined, label: string): string | undefined {
  if (!values?.length) return undefined;
  for (const value of values) ensureArg(value, label);
  if (values.some((value) => value.includes(",")))
    throw new TypeError(`${label} entries must not contain commas.`);
  return values.join(",");
}
