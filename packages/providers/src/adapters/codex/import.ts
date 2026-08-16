import { normalizeCodexStream } from "./stream.js";
import type { CodexHistoricalImport } from "./types.js";

/** Historical Codex JSONL is an unstable provider format and always carries provenance. */
export function importCodexHistory(
  input: string | Iterable<string>,
  options: { source: string; providerVersion?: string; importedAt?: string },
): CodexHistoricalImport {
  const providerVersion = options.providerVersion ?? "unknown";
  const events = normalizeCodexStream(input);
  const session = events.find((event) => event.sessionId);
  const diagnostics = events
    .filter((event) => event.kind === "diagnostic")
    .map((event) => event.diagnostic?.message ?? "provider diagnostic");
  return {
    provider: "codex",
    format: "codex-jsonl",
    formatVersion: `codex-cli-${providerVersion}`,
    unstable: true,
    provenance: {
      source: options.source,
      provider: "codex",
      providerVersion,
      importedAt: options.importedAt ?? new Date().toISOString(),
    },
    ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
    ...(session?.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    events,
    diagnostics,
  };
}

export const parseCodexHistory = importCodexHistory;
