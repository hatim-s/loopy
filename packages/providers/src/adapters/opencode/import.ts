import { normalizeOpenCodeJsonLines } from "./events.js";
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
      ) {
        const schemaVersion = (parsed as Record<string, unknown>).schemaVersion;
        if (schemaVersion !== undefined && schemaVersion !== "opencode.export.v1") {
          diagnostics.push(
            diagnostic(
              "unsupported_version",
              `OpenCode export version ${String(schemaVersion)} is unsupported; expected opencode.export.v1.`,
            ),
          );
        } else {
          eventsInput.push(...((parsed as Record<string, unknown>).events as unknown[]));
        }
      } else if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as Record<string, unknown>).schemaVersion === "string" &&
        (parsed as Record<string, unknown>).schemaVersion !== "opencode.export.v1"
      ) {
        diagnostics.push(
          diagnostic(
            "unsupported_version",
            `OpenCode export version ${String((parsed as Record<string, unknown>).schemaVersion)} is unsupported; expected opencode.export.v1.`,
          ),
        );
      } else eventsInput.push(parsed);
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
        provenance: {
          ...(context.source ? { source: context.source } : {}),
          format: "run-json",
          ...(context.providerVersion ? { version: context.providerVersion } : {}),
          diagnostics: normalized.diagnostics,
        },
      };
    }
  } else if (Array.isArray(input)) eventsInput.push(...input);
  else if (
    input &&
    typeof input === "object" &&
    Array.isArray((input as Record<string, unknown>).events)
  ) {
    const schemaVersion = (input as Record<string, unknown>).schemaVersion;
    if (schemaVersion !== undefined && schemaVersion !== "opencode.export.v1") {
      diagnostics.push(
        diagnostic(
          "unsupported_version",
          `OpenCode export version ${String(schemaVersion)} is unsupported; expected opencode.export.v1.`,
        ),
      );
    } else {
      eventsInput.push(...((input as Record<string, unknown>).events as unknown[]));
    }
  } else eventsInput.push(input);
  const expanded: unknown[] = [];
  for (const raw of eventsInput) {
    if (raw && typeof raw === "object" && "messages" in raw && Array.isArray(raw.messages)) {
      const info =
        "info" in raw && raw.info && typeof raw.info === "object"
          ? (raw.info as Record<string, unknown>)
          : {};
      for (const message of raw.messages) {
        if (!message || typeof message !== "object") continue;
        const row = message as Record<string, unknown>;
        const meta =
          row.info && typeof row.info === "object" ? (row.info as Record<string, unknown>) : {};
        for (const part of Array.isArray(row.parts) ? row.parts : []) {
          if (!part || typeof part !== "object") continue;
          expanded.push({
            type:
              part.type === "tool"
                ? "tool_use"
                : part.type === "step-finish"
                  ? "step_finish"
                  : part.type === "step-start"
                    ? "step_start"
                    : part.type,
            part,
            role: meta.role,
            sessionID: meta.sessionID ?? info.id,
          });
        }
      }
    } else expanded.push(raw);
  }
  eventsInput.splice(0, eventsInput.length, ...expanded);
  const events = [] as OpenCodeImportedSession["events"];
  const normalized = await normalizeOpenCodeJsonLines(
    eventsInput.map((raw) => JSON.stringify(raw)),
    context,
  );
  events.push(...normalized.events);
  diagnostics.push(...normalized.diagnostics);
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
    provenance: {
      ...(context.source ? { source: context.source } : {}),
      format: "opencode.export.v1",
      ...(context.providerVersion ? { version: context.providerVersion } : {}),
      diagnostics,
    },
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
