import type { z } from "zod";
import { type eventsQuerySchema, routes, serverEvent } from "../../contract/index.js";
import type { RuntimeEvent } from "../../core/index.js";
import { type LoopyService, ServiceError } from "../service.js";
import type { SqliteRunStore } from "../store.js";

type EventsQuery = z.infer<typeof eventsQuerySchema>;

export async function eventStream(
  store: SqliteRunStore,
  service: LoopyService,
  query: EventsQuery,
  signal: AbortSignal,
): Promise<Response> {
  const oldest = store.eventBounds()?.oldest;

  if (
    query.epoch !== (await store.epoch()) ||
    (oldest !== null && oldest !== undefined && query.after < oldest - 1)
  ) {
    throw new ServiceError("stale_cursor");
  }

  const feed = new EventFeed(store, service, query.after, signal);

  const stream = new ReadableStream<Uint8Array>(
    {
      start: (controller) => feed.start(controller),
      cancel: () => feed.close(),
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }),
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

class EventFeed {
  private closed = false;
  private pending = false;
  private dirty = false;
  private version: number;
  private tail?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private controller?: ReadableStreamDefaultController<Uint8Array>;

  constructor(
    private readonly store: SqliteRunStore,
    private readonly service: LoopyService,
    private cursor: number,
    private readonly signal: AbortSignal,
  ) {
    this.version = store.dataVersion();
  }

  start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.controller = controller;
    this.send(": connected\n\n");
    this.unsubscribe = this.store.subscribe(this.enqueue);
    this.tail = setInterval(() => {
      const next = this.store.dataVersion();

      if (next !== this.version) {
        this.version = next;
        this.enqueue();
      }
    }, 100);
    this.heartbeat = setInterval(() => this.send(": heartbeat\n\n"), 15_000);
    this.signal.addEventListener("abort", this.abort, { once: true });

    if (this.signal.aborted) {
      this.abort();
    } else {
      this.enqueue();
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    clearInterval(this.tail);
    clearInterval(this.heartbeat);
    this.unsubscribe?.();
    this.signal.removeEventListener("abort", this.abort);
  }

  private readonly abort = () => {
    if (this.closed) {
      return;
    }

    this.close();
    this.controller?.close();
  };

  private send(text: string): void {
    const controller = this.controller;

    if (this.closed || !controller) {
      return;
    }

    const bytes = new TextEncoder().encode(text);

    if ((controller.desiredSize ?? 0) < bytes.byteLength) {
      this.close();
      controller.error(new Error("SSE client fell behind. Reconnect from the last event ID."));

      return;
    }

    controller.enqueue(bytes);
  }

  private readonly enqueue = () => {
    this.dirty = true;

    if (!this.pending) {
      this.pending = true;
      queueMicrotask(() => void this.flush());
    }
  };

  private async flush(): Promise<void> {
    try {
      while (this.dirty && !this.closed) {
        this.dirty = false;
        await this.drain();
      }
    } catch (error) {
      if (!this.closed) {
        this.close();
        this.controller?.error(error);
      }
    } finally {
      this.pending = false;
    }
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      this.dirty = false;
      const events = await this.store.events(this.cursor, 500);

      const last = events.at(-1);

      if (!last) {
        return;
      }

      // A reconnect cursor must never acknowledge only part of a transaction.
      events.push(...(await this.store.transactionEvents(last.txn, last.sequence)));

      for (const transaction of transactions(events)) {
        if (this.closed) {
          return;
        }

        await this.deliver(transaction);
      }
    }
  }

  private async deliver(transaction: RuntimeEvent[]): Promise<void> {
    const ids = [
      ...new Set(transaction.flatMap((event) => (event.entity === "run" ? [event.record.id] : []))),
    ];

    const view = await this.service.viewResolver(ids);
    const data = transaction.map((event) => routes.events.response.parse(serverEvent(event, view)));
    this.cursor = transaction.at(-1)?.sequence ?? this.cursor;
    this.send(`id: ${this.cursor}\nevent: txn\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function transactions(events: RuntimeEvent[]): RuntimeEvent[][] {
  const groups: RuntimeEvent[][] = [];

  for (const event of events) {
    const last = groups.at(-1);

    if (last?.[0]?.txn === event.txn) {
      last.push(event);
    } else {
      groups.push([event]);
    }
  }

  return groups;
}
