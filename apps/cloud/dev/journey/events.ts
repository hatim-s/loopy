import { decodeEventBatch, routes, type ServerEvent, splitSseFrames } from "@loopy/contract";
import { assert, equal, JourneyFailure } from "../shared/assert";
import type { Journey } from "./client";

function decode(data: string): ServerEvent[] {
  try {
    return decodeEventBatch(data);
  } catch {
    throw new JourneyFailure({ failure: "sse_transaction_schema_failed" });
  }
}

export async function frame(journey: Journey, after: number, epoch: string, lastEventId?: number) {
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), 15_000);

  try {
    const response = await journey.send(
      routes.events,
      { query: { after, epoch } },
      {
        headers: lastEventId === undefined ? {} : { "Last-Event-ID": String(lastEventId) },
        signal: aborter.signal,
      },
    );

    assert(response.ok, "sse_http_failed", { httpStatus: response.status });
    assert(
      response.headers.get("content-type")?.includes("text/event-stream"),
      "sse_content_type_failed",
    );
    assert(response.body, "missing_sse_body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const chunk = await reader.read();
      assert(!chunk.done, "sse_ended_before_transaction");
      buffer += decoder.decode(chunk.value, { stream: true });
      assert(buffer.length < 4 * 1024 * 1024, "sse_frame_exceeds_limit");
      const split = splitSseFrames(buffer);
      buffer = split.rest;
      const first = split.frames[0];

      if (first) {
        const events = decode(first.data);
        assert(events.length > 0, "sse_transaction_schema_failed");
        const id = Number(first.id);
        equal(id, events.at(-1)?.sequence, "sse_id_not_transaction_end");
        assert(
          events.every((event) => event.sequence > (lastEventId ?? after)),
          "sse_replayed_acknowledged_events",
        );
        equal(new Set(events.map((event) => event.txn)).size, 1, "sse_mixed_transactions");

        return { id, events };
      }
    }
  } catch (cause) {
    if (cause instanceof JourneyFailure) {
      throw cause;
    }

    throw new JourneyFailure({ failure: "sse_transport_or_decode_failed" });
  } finally {
    clearTimeout(timer);
    aborter.abort();
  }
}
