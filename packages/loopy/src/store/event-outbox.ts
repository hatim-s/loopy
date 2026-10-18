import type { RuntimeEvent } from "../core/index.js";

export type EventTransaction = { id: string; events: RuntimeEvent[] };

export const EVENT_RETENTION = { maxAgeMs: 86_400_000, maxRows: 100_000 } as const;

export class EventListeners {
  private readonly listeners = new Set<(events: RuntimeEvent[]) => void>();

  subscribe(listener: (events: RuntimeEvent[]) => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(events: RuntimeEvent[]): void {
    if (events.length === 0) {
      return;
    }

    for (const listener of this.listeners) {
      try {
        listener(structuredClone(events));
      } catch {
        continue;
      }
    }
  }
}
