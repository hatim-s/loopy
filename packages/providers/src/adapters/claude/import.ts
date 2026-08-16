import { normalizeClaudeStream } from "./stream.js";
import type { ClaudeHistoricalImport } from "./types.js";

/** Claude Code history is explicitly unstable: retain source and observed version on every import. */
export function importClaudeHistory(
  input: string | Iterable<string>,
  options: { source: string; providerVersion?: string; importedAt?: string },
): ClaudeHistoricalImport {
  const providerVersion = options.providerVersion ?? "unknown";
  const events = normalizeClaudeStream(input);
  const session = events.find((event) => event.sessionId);
  const diagnostics = events
    .filter((event) => event.kind === "diagnostic")
    .map((event) => event.diagnostic?.message ?? "provider diagnostic");
  return {
    provider: "claude",
    format: "claude-stream-json",
    formatVersion: `claude-code-${providerVersion}`,
    unstable: true,
    provenance: {
      source: options.source,
      provider: "claude",
      providerVersion,
      importedAt: options.importedAt ?? new Date().toISOString(),
    },
    ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
    ...(session?.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    events,
    diagnostics,
  };
}
export const parseClaudeHistory = importClaudeHistory;
