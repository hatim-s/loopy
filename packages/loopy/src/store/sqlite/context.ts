import type { Database } from "bun:sqlite";
import type { EventListeners } from "../event-outbox.js";

export type StoreContext = {
  db: Database;
  now: () => number;
  leaseMs: number;
  listeners: EventListeners;
};
