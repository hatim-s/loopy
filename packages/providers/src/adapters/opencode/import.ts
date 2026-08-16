import { normalizeOpenCodeEvent, normalizeOpenCodeJsonLines } from "./events.js";
import type { OpenCodeImportedSession, ProviderAdapterContext } from "./types.js";
import { diagnostic, parseJsonLine } from "./util.js";

export const OPENCODE_IMPORTER_VERSION = "1" as const;

export async function importOpenCodeSession(
  input: string | unknown,
  context: ProviderAdapterContext = {},
): Promise<OpenCodeImportedSession> {
  const diagnostics = [] as OpenCodeImportedSession["diagnostics"];
  let sourceFormat: OpenCodeImportedSession["sourceFormat"] = "official-export";
  const eventsInput: unknown[] = [];
  if (typeof input === "string") {
    const trimmed = input.trim();
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) eventsInput.push(...parsed);
      else if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as Record<string, unknown>).events)
      )
        eventsInput.push(...((parsed as Record<string, unknown>).events as unknown[]));
      else eventsInput.push(parsed);
    } catch {
      sourceFormat = "run-json";
      const lines = trimmed.split(/\r?\n/);
      const normalized = await normalizeOpenCodeJsonLines(lines, context);
      const sessionId =
        context.sessionId ??
        normalized.events.find((event) => event.sessionId)?.sessionId ??
        "opencode-import-session";
      return {
        schemaVersion: "opencode.export.v1",
        provider: "opencode",
        sessionId: sessionId ?? "opencode-import-session",
        sourceFormat,
        events: normalized.events,
        diagnostics: normalized.diagnostics,
      };
    }
  } else if (Array.isArray(input)) eventsInput.push(...input);
  else if (
    input &&
    typeof input === "object" &&
    Array.isArray((input as Record<string, unknown>).events)
  )
    eventsInput.push(...((input as Record<string, unknown>).events as unknown[]));
  else eventsInput.push(input);
  const events = [] as OpenCodeImportedSession["events"];
  let sequence = context.sequence ?? 0;
  for (const raw of eventsInput) {
    const normalized = normalizeOpenCodeEvent(raw, { ...context, sequence });
    diagnostics.push(...normalized.diagnostics);
    if (normalized.event) {
      events.push(normalized.event);
      sequence += 1;
    }
  }
  const sessionId =
    context.sessionId ??
    events.find((event) => event.sessionId)?.sessionId ??
    "opencode-import-session";
  return {
    schemaVersion: "opencode.export.v1",
    provider: "opencode",
    sessionId,
    sourceFormat,
    events,
    diagnostics,
  };
}

export function parseOpenCodeSessionList(input: string | unknown): {
  sessions: Array<{
    id: string;
    title?: string;
    directory?: string;
    updatedAt?: string;
    parentId?: string;
  }>;
  diagnostics: OpenCodeImportedSession["diagnostics"];
} {
  const diagnostics = [] as OpenCodeImportedSession["diagnostics"];
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      const line = parseJsonLine(input);
      value = line.value;
      if (line.error) diagnostics.push(line.error);
    }
  }
  const rows: unknown[] = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as Record<string, unknown>).sessions)
      ? ((value as Record<string, unknown>).sessions as unknown[])
      : [];
  const sessions = rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const id =
      typeof record.id === "string"
        ? record.id
        : typeof record.sessionID === "string"
          ? record.sessionID
          : undefined;
    if (!id) {
      diagnostics.push(diagnostic("malformed_event", "OpenCode session list entry has no id."));
      return [];
    }
    return [
      {
        id,
        ...(typeof record.title === "string" ? { title: record.title } : {}),
        ...(typeof record.directory === "string" ? { directory: record.directory } : {}),
        ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
        ...(typeof record.parentId === "string" ? { parentId: record.parentId } : {}),
      },
    ];
  });
  return { sessions, diagnostics };
}
