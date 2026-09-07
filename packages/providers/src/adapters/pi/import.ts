import { normalizePiJsonLines } from "./events.js";
import {
  PI_SESSION_FORMAT_V3,
  type PiImportedSession,
  type ProviderAdapterContext,
} from "./types.js";
import { diagnostic, parseJsonLine } from "./util.js";

export const PI_IMPORTER_VERSION = "1" as const;

export async function importPiSession(
  input: string | unknown,
  context: ProviderAdapterContext = {},
): Promise<PiImportedSession> {
  let version: number = PI_SESSION_FORMAT_V3;
  let sourceFormat: PiImportedSession["sourceFormat"] = "session-jsonl";
  const diagnostics = [] as PiImportedSession["diagnostics"];
  const events: PiImportedSession["events"] = [];
  if (typeof input === "string") {
    const lines = input.trim().split(/\r?\n/).filter(Boolean);
    const first = parseJsonLine(lines[0] ?? "");
    const firstValue = first.value;
    if (firstValue && typeof firstValue.version === "number") version = firstValue.version;
    if (firstValue && firstValue.type !== "session") sourceFormat = "run-json";
    if (version !== PI_SESSION_FORMAT_V3)
      diagnostics.push(
        diagnostic(
          "unsupported_version",
          `Pi session file version ${version} is unsupported; expected ${PI_SESSION_FORMAT_V3}.`,
        ),
      );
    if (version === PI_SESSION_FORMAT_V3) {
      const normalized = await normalizePiJsonLines(lines, context);
      events.push(...normalized.events);
      diagnostics.push(...normalized.diagnostics);
    }
  } else if (Array.isArray(input) || (input && typeof input === "object")) {
    const object = input as Record<string, unknown>;
    const rows = Array.isArray(input)
      ? input
      : Array.isArray(object.messages)
        ? [
            {
              type: "session",
              version: object.version ?? PI_SESSION_FORMAT_V3,
              id: object.id ?? context.sessionId,
            },
            ...object.messages,
          ]
        : [input];
    const normalized = await importPiSession(
      rows.map((row) => JSON.stringify(row)).join("\n"),
      context,
    );
    return normalized;
  } else
    diagnostics.push(
      diagnostic("malformed_event", "Pi session input must be JSONL, an array, or an object."),
    );
  const sessionId =
    context.sessionId ?? events.find((event) => event.sessionId)?.sessionId ?? "pi-import-session";
  return {
    schemaVersion: "pi.session.v3",
    provider: "pi",
    sessionId,
    sourceFormat,
    sessionFileVersion: version,
    events,
    diagnostics,
    provenance: {
      ...(context.source ? { source: context.source } : {}),
      format: "pi.session.v3",
      version,
      ...(context.providerVersion ? { providerVersion: context.providerVersion } : {}),
    },
  };
}
