import type { Schema } from "effect";
import { decodeBoundary } from "../../../packages/loopy/src/contract";
import type { Sample } from "./statistics";

type Request = (path: string, signal: AbortSignal) => Promise<Response>;

type Observation = Sample["observation"];

export function createMeasure(request: Request, samples: Sample[]) {
  return async function measure<T>(
    endpoint: string,
    path: string,
    schema: Schema.Codec<T, unknown, never, never>,
    observe: (value: T) => Observation = () => ({}),
  ) {
    const began = performance.now();

    const sample: Sample = {
      endpoint,
      at: new Date().toISOString(),
      status: null,
      bytes: 0,
      headersMs: null,
      totalMs: 0,
      parseMs: null,
      failure: null,
      observation: {},
    };

    try {
      const response = await request(path, AbortSignal.timeout(15_000));
      sample.headersMs = performance.now() - began;
      sample.status = response.status;
      const chunks: Uint8Array[] = [];

      if (response.body) {
        const reader = response.body.getReader();

        try {
          while (true) {
            const chunk = await reader.read();

            if (chunk.done) {
              break;
            }

            sample.bytes += chunk.value.byteLength;

            if (sample.bytes > 8 * 1024 * 1024) {
              sample.failure = "body_limit";
              await reader.cancel();
              break;
            }

            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      }

      sample.totalMs = performance.now() - began;

      if (sample.failure !== null) {
        return;
      }

      if (!response.ok) {
        sample.failure = "http";

        return;
      }

      const parseStart = performance.now();

      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const parsed = decodeBoundary(schema)(value);
        sample.parseMs = performance.now() - parseStart;

        sample.observation = observe(parsed);
      } catch {
        sample.parseMs = performance.now() - parseStart;
        sample.failure = "schema";
      }
    } catch {
      sample.failure = "transport";
    } finally {
      sample.totalMs ||= performance.now() - began;
      samples.push(sample);
    }
  };
}
