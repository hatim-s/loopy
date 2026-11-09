import { eventFrame, type routes, SSE_CONNECTED, SSE_HEARTBEAT } from "@loopy/contract";
import type { RuntimeEvent, Store } from "@loopy/core";
import { Effect, type Schema } from "effect";
import { ServiceError } from "./error";
import type { Service } from "./service";

export type EventReader = Pick<
  Store,
  "oldestEventSequence" | "epoch" | "events" | "transactionEvents" | "subscribe"
>;

type EventService = Pick<Service, "events">;

// A full queue is normal while a reader drains; two seconds without a pull is a reader that stopped.
const STALLED_READER_MS = 2000;

const ENCODER = new TextEncoder();

type EventsQuery = Schema.Schema.Type<typeof routes.events.query>;

export const eventStream = Effect.fn("events.eventStream")(function* (
  store: EventReader,
  service: EventService,
  query: EventsQuery,
  signal: AbortSignal,
) {
  yield* validateCursor(store, query.after, query.epoch);
  yield* readTransaction(store, query.after);

  const feed = new EventFeed(store, service, query.after, query.epoch, signal);

  const stream = new ReadableStream<Uint8Array>(
    {
      start: (controller) => feed.start(controller),
      pull: () => feed.pull(),
      cancel: () => feed.close(),
    },
    new CountQueuingStrategy({ highWaterMark: 1 }),
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

class EventFeed {
  private closed = false;
  private pending = false;
  private dirty = false;
  private drained?: () => void;
  private stalled?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private controller?: ReadableStreamDefaultController<Uint8Array>;

  constructor(
    private readonly store: EventReader,
    private readonly service: EventService,
    private cursor: number,
    private readonly epoch: string,
    private readonly signal: AbortSignal,
  ) {}

  start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.controller = controller;
    controller.enqueue(ENCODER.encode(SSE_CONNECTED));
    this.unsubscribe = this.store.subscribe(this.enqueue);

    this.heartbeat = setInterval(() => {
      if ((controller.desiredSize ?? 0) > 0) {
        controller.enqueue(ENCODER.encode(SSE_HEARTBEAT));
      }
    }, 15_000);
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
    this.pull();
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

  pull(): void {
    clearTimeout(this.stalled);
    this.drained?.();
    this.drained = undefined;
  }

  private async send(text: string): Promise<void> {
    const controller = this.controller;

    if (this.closed || !controller) {
      return;
    }

    // One queued and one pending transaction bound memory without splitting large frames.
    while (!this.closed && (controller.desiredSize ?? 0) <= 0) {
      await new Promise<void>((resolve) => {
        this.drained = resolve;
        this.stalled = setTimeout(() => {
          this.close();
          controller.error(new Error("SSE client fell behind. Reconnect from the last event ID."));
        }, STALLED_READER_MS);
      });
    }

    if (!this.closed) {
      controller.enqueue(ENCODER.encode(text));
    }
  }

  private readonly enqueue = () => {
    if (this.closed) {
      return;
    }

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
      await Effect.runPromise(validateCursor(this.store, this.cursor, this.epoch));
      const events = await Effect.runPromise(readTransaction(this.store, this.cursor));

      if (events.length === 0) {
        return;
      }

      await this.deliver(events);
    }
  }

  private async deliver(transaction: RuntimeEvent[]): Promise<void> {
    const events = await Effect.runPromise(this.service.events(transaction));
    this.cursor = transaction.at(-1)?.sequence ?? this.cursor;
    await this.send(eventFrame(this.cursor, events));
  }
}

const validateCursor = Effect.fn("events.validateCursor")(function* (
  store: EventReader,
  after: number,
  epoch: string,
) {
  const oldest = yield* store.oldestEventSequence();

  if (epoch !== (yield* store.epoch()) || (oldest !== undefined && after < oldest - 1)) {
    return yield* Effect.fail(new ServiceError("stale_cursor"));
  }
});

const readTransaction = Effect.fn("events.readTransaction")(function* (
  store: EventReader,
  after: number,
) {
  const [first] = yield* store.events(after, 1);

  if (!first) {
    return [];
  }

  const transaction = yield* store.transactionEvents(first.txn, 0);

  // Accepting a cursor inside a transaction would acknowledge an incomplete state change.
  if (transaction.some((event) => event.sequence <= after)) {
    return yield* Effect.fail(
      new ServiceError(
        "stale_cursor",
        "The event cursor splits a transaction. Fetch a fresh snapshot.",
      ),
    );
  }

  if (transaction[0]?.sequence !== first.sequence) {
    return yield* Effect.fail(new ServiceError("stale_cursor"));
  }

  return transaction;
});
