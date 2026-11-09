import { isoDateTime } from "@loopy/contract";
import { Schema } from "effect";
import { distribution } from "../../shared/stats";

const nonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const sampleSchema = Schema.Struct({
  endpoint: Schema.String,
  at: isoDateTime,
  status: Schema.NullOr(Schema.Int),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  headersMs: Schema.NullOr(nonNegative),
  totalMs: nonNegative,
  parseMs: Schema.NullOr(nonNegative),
  failure: Schema.NullOr(Schema.Literals(["transport", "schema", "http", "body_limit"])),
  observation: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
});

export type Sample = typeof sampleSchema.Type;

export const distributionSchema = Schema.Struct({
  count: Schema.Int,
  min: Schema.NullOr(Schema.Number),
  p50: Schema.NullOr(Schema.Number),
  p95: Schema.NullOr(Schema.Number),
  p99: Schema.NullOr(Schema.Number),
  max: Schema.NullOr(Schema.Number),
});

export const countsSchema = Schema.Record(Schema.String, Schema.Int);

export function countBy<T>(values: readonly T[], key: (value: T) => string) {
  const counts: Record<string, number> = {};

  for (const value of values) {
    const name = key(value);
    counts[name] = (counts[name] ?? 0) + 1;
  }

  return counts;
}

// Missing or reversed timestamps stay unknown instead of becoming zero.
export function elapsedMs(from: string | null | undefined, to: string | null | undefined) {
  if (!from || !to) {
    return null;
  }

  const value = Date.parse(to) - Date.parse(from);

  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function known(values: readonly (number | null)[]) {
  return values.filter((value) => value !== null);
}

export const endpointSummarySchema = Schema.Struct({
  endpoint: Schema.String,
  samples: Schema.Int,
  statuses: countsSchema,
  failures: Schema.Int,
  latencyMs: distributionSchema,
  bytes: distributionSchema,
});

export function summarize(samples: readonly Sample[]) {
  return [...new Set(samples.map((sample) => sample.endpoint))].map((endpoint) => {
    const selected = samples.filter((sample) => sample.endpoint === endpoint);

    return {
      endpoint,
      samples: selected.length,
      statuses: countBy(selected, (sample) => String(sample.status ?? "transport")),
      failures: selected.filter((sample) => sample.failure !== null).length,
      latencyMs: distribution(selected.map((sample) => sample.totalMs)),
      bytes: distribution(selected.map((sample) => sample.bytes)),
    };
  });
}
