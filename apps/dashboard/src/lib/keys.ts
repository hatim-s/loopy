import type { RunsQuery } from "../backend/backend.ts";

/** Every Query key the dashboard uses. The stream reducer writes into the same keys. */
export const keys = {
  loopies: ["loopies"],
  runLists: ["runs"],
  runs: (query: RunsQuery) => ["runs", query],
  run: (id: string) => ["run", id],
} as const;
