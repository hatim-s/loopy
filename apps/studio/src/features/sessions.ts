export type { ImportedSessionListProps } from "./components.tsx";
export { ImportedSessionList } from "./components.tsx";
export type { ImportedSession, ImportedSessionLossiness } from "./types.ts";

export function importedSessionsQuery() {
  return {
    kind: "query" as const,
    key: ["sessions", "imported"] as const,
    endpoint: "/api/sessions/imported",
  };
}

export function importedSessionQuery(importId: string) {
  return {
    kind: "query" as const,
    key: ["sessions", "imported", importId] as const,
    endpoint: `/api/sessions/imported/${encodeURIComponent(importId)}`,
  };
}
