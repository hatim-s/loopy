import type { RuntimeEvent } from "@loopy/core";
import { Effect } from "effect";

type Listener = (events: RuntimeEvent[]) => void;

// Delivery runs after commit. A listener failure must not turn a committed write into a storage
// error, so a throwing listener is logged and unsubscribed instead of being called again.
export class EventListeners {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(events: RuntimeEvent[]): void {
    if (events.length === 0 || this.listeners.size === 0) {
      return;
    }

    // One copy per commit detaches listeners from the writer's records. Listeners only read it.
    const delivered = structuredClone(events);

    for (const listener of this.listeners) {
      try {
        listener(delivered);
      } catch (cause) {
        this.listeners.delete(listener);
        Effect.runSync(
          Effect.logError("A store event listener threw and was unsubscribed.", cause),
        );
      }
    }
  }
}
