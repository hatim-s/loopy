import type { RuntimeEvent } from "@loopy/core";

export const EVENT_RETENTION = { maxAgeMs: 86_400_000, maxRows: 100_000 } as const;

type Listener = (events: RuntimeEvent[]) => void;

// Delivery runs after commit. A listener failure must not turn a committed write into a storage error.
export class EventListeners {
  private readonly listeners = new Set<Listener>();

  get size(): number {
    return this.listeners.size;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(events: RuntimeEvent[]): void {
    if (events.length > 0) {
      this.deliver(events);
    }
  }

  // Storage changed without events from this connection. Listeners re-read what they need.
  notify(): void {
    this.deliver([]);
  }

  private deliver(events: RuntimeEvent[]): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(events));
      } catch {
        continue;
      }
    }
  }
}
