import type { RunsQuery } from "../backend/backend.ts";

/** The filters a paged run list is keyed by; the page cursor lives in the query itself. */
export type RunFilters = Pick<RunsQuery, "slug" | "status">;

/** Every Query key the dashboard uses. The stream reducer writes into the same keys. */
export const keys = {
  loopies: ["loopies"],
  runLists: ["runs"],
  runs: (query: RunsQuery) => ["runs", query] as const,
  runPages: (filters: RunFilters) => ["runs", "pages", filters] as const,
  run: (id: string) => ["run", id] as const,
  daemon: ["daemon"],
} as const;

type DashboardKey = (typeof keys)[keyof typeof keys];

type QueryKey = DashboardKey extends infer Key
  ? Key extends (...args: never[]) => infer Result
    ? Result
    : Key
  : never;

declare module "@tanstack/react-query" {
  interface Register {
    queryKey: QueryKey;
  }
}
