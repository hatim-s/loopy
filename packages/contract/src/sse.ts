import { Schema } from "effect";
import { decodeJson, encodeBoundary } from "./codec";
import { type ServerEvent, serverEventSchema } from "./views";

/** One frame carries every event of one store transaction. */
const eventBatchSchema = Schema.Array(serverEventSchema).pipe(Schema.mutable);

const encodeBatch = encodeBoundary(eventBatchSchema);

export const decodeEventBatch = decodeJson(eventBatchSchema);

export const SSE_CONNECTED = ": connected\n\n";

export const SSE_HEARTBEAT = ": heartbeat\n\n";

/** The frame id is the transaction's last sequence, which a reconnect sends as Last-Event-ID. */
export function eventFrame(sequence: number, events: ServerEvent[]): string {
  return `id: ${sequence}\nevent: txn\ndata: ${JSON.stringify(encodeBatch(events))}\n\n`;
}

export type SseFrame = { readonly id: string | null; readonly data: string };

/** Splits buffered stream text into complete data frames and the unfinished tail. */
export function splitSseFrames(buffer: string) {
  let rest = buffer.replaceAll("\r\n", "\n");
  const frames: SseFrame[] = [];

  for (let end = rest.indexOf("\n\n"); end !== -1; end = rest.indexOf("\n\n")) {
    const lines = rest.slice(0, end).split("\n");
    rest = rest.slice(end + 2);
    const data = lines.filter((line) => line.startsWith("data:"));

    if (data.length > 0) {
      frames.push({
        id:
          lines
            .find((line) => line.startsWith("id:"))
            ?.slice(3)
            .trimStart() ?? null,
        data: data.map((line) => line.slice(5).replace(/^ /, "")).join("\n"),
      });
    }
  }

  return { frames, rest };
}
