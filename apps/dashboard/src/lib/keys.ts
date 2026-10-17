import type { RunsQuery } from "../backend/backend.ts";

/** The filters a paged run list is keyed by; the page cursor lives in the query itself. */
export type RunFilters = Pick<RunsQuery, "slug" | "status">;

/** Every Query key the dashboard uses. The stream reducer writes into the same keys. */
export const keys = {
  loopies: ["loopies"],
  runLists: ["runs"],
  runs: (query: RunsQuery) => ["runs", query],
  runPages: (filters: RunFilters) => ["runs", "pages", filters],
  run: (id: string) => ["run", id],
  daemon: ["daemon"],
} as const;
