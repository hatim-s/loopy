import { decodeBoundary } from "@loopy/contract";
import type { Schema } from "effect";
import type { Sample } from "./statistics";

type Request = (path: string, signal: AbortSignal) => Promise<Response>;

type Observation = Sample["observation"];

const BODY_LIMIT = 8 * 1024 * 1024;

type Read = { status: number; ok: boolean; headersMs: number; chunks: Uint8Array[]; bytes: number };

// The body is read chunk by chunk so the timing covers the transfer and the cap applies before
// buffering, which the shared client cannot provide.
async function readBody(request: Request, path: string, began: number): Promise<Read> {
  const response = await request(path, AbortSignal.timeout(15_000));

  const read: Read = {
    status: response.status,
    ok: response.ok,
    headersMs: performance.now() - began,
    chunks: [],
    bytes: 0,
  };

  if (!response.body) {
    return read;
  }

  const reader = response.body.getReader();

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      read.bytes += chunk.value.byteLength;

      if (read.bytes > BODY_LIMIT) {
        await reader.cancel();
        break;
      }

      read.chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  return read;
}

export function createMeasure(request: Request, samples: Sample[]) {
  return async function measure<T>(
    endpoint: string,
    path: string,
    schema: Schema.Codec<T, unknown, never, never>,
    observe: (value: T) => Observation = () => ({}),
  ) {
    const began = performance.now();
    const at = new Date().toISOString();
    const empty = { status: null, bytes: 0, headersMs: null, parseMs: null, observation: {} };

    let read: Read;

    try {
      read = await readBody(request, path, began);
    } catch {
      samples.push({
        endpoint,
        at,
        ...empty,
        totalMs: performance.now() - began,
        failure: "transport",
      });

      return;
    }

    const base = {
      endpoint,
      at,
      status: read.status,
      bytes: read.bytes,
      headersMs: read.headersMs,
      totalMs: performance.now() - began,
    };

    if (read.bytes > BODY_LIMIT || !read.ok) {
      samples.push({
        ...base,
        parseMs: null,
        failure: read.bytes > BODY_LIMIT ? "body_limit" : "http",
        observation: {},
      });

      return;
    }

    const parseStart = performance.now();

    try {
      const parsed = decodeBoundary(schema)(
        JSON.parse(Buffer.concat(read.chunks).toString("utf8")),
      );

      samples.push({
        ...base,
        parseMs: performance.now() - parseStart,
        failure: null,
        observation: observe(parsed),
      });
    } catch {
      samples.push({
        ...base,
        parseMs: performance.now() - parseStart,
        failure: "schema",
        observation: {},
      });
    }
  };
}
