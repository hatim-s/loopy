export function distribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);

  const percentile = (fraction: number) =>
    sorted.length === 0
      ? null
      : (sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null);

  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
  };
}

export type Sample = {
  endpoint: string;
  at: string;
  status: number | null;
  bytes: number;
  headersMs: number | null;
  totalMs: number;
  parseMs: number | null;
  failure: "transport" | "schema" | "http" | "body_limit" | null;
  observation: Record<string, string | number | boolean | null>;
};

export function summarize(samples: Sample[]) {
  return [...new Set(samples.map((sample) => sample.endpoint))].map((endpoint) => {
    const selected = samples.filter((sample) => sample.endpoint === endpoint);
    const statuses: Record<string, number> = {};

    for (const sample of selected) {
      const key = String(sample.status ?? "transport");
      statuses[key] = (statuses[key] ?? 0) + 1;
    }

    return {
      endpoint,
      samples: selected.length,
      statuses,
      failures: selected.filter((sample) => sample.failure !== null).length,
      latencyMs: distribution(selected.map((sample) => sample.totalMs)),
      bytes: distribution(selected.map((sample) => sample.bytes)),
    };
  });
}
