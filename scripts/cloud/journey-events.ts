import { Result, Schema } from "effect";
import { boundaryOptions, routes } from "../../packages/loopy/src/contract/index.js";
import { assert, equal, type Journey, JourneyFailure } from "./journey-client.js";

export async function frame(journey: Journey, after: number, epoch: string, lastEventId?: number) {
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), 15_000);

  try {
    const response = await journey.request(
      `/events?after=${after}&epoch=${encodeURIComponent(epoch)}`,
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
      let separator = buffer.indexOf("\n\n");

      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));

        if (data) {
          const decoded = Schema.decodeUnknownResult(
            Schema.Array(routes.events.response),
            boundaryOptions,
          )(JSON.parse(data.slice(6)));

          assert(Result.isSuccess(decoded), "sse_transaction_schema_failed");
          const events = decoded.success;

          assert(events.length > 0, "sse_transaction_schema_failed");

          const id = Number(
            frame
              .split("\n")
              .find((line) => line.startsWith("id: "))
              ?.slice(4),
          );

          equal(id, events.at(-1)?.sequence, "sse_id_not_transaction_end");
          assert(
            events.every((event) => event.sequence > (lastEventId ?? after)),
            "sse_replayed_acknowledged_events",
          );
          equal(new Set(events.map((event) => event.txn)).size, 1, "sse_mixed_transactions");

          return { id, events: events };
        }

        separator = buffer.indexOf("\n\n");
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
