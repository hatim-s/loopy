import { encodeRunCursor, type RunView, routes } from "../../../packages/loopy/src/contract";
import { executionKeyString } from "../../../packages/loopy/src/core";
import { createMeasure } from "./request";
import { resources } from "./resources";
import { type Sample, summarize } from "./statistics";

type Request = (path: string, signal: AbortSignal) => Promise<Response>;

type ApiEvidence = {
  scope: string;
  phase: string;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  targetRequestsPerSecond: number;
  samples: Sample[];
  summaries: ReturnType<typeof summarize>;
  resources: Awaited<ReturnType<typeof resources>>[];
  limits: string[];
};

export async function sampleApi(options: {
  phase: string;
  seconds: number;
  requestsPerSecond: number;
  request: Request;
  save: (value: ApiEvidence) => Promise<void>;
  shouldStop?: () => boolean;
  onProgress?: (progress: {
    phase: string;
    samples: number;
    failures: number;
    elapsedMs: number;
  }) => void;
}) {
  const samples: Sample[] = [];
  const resourceSamples = [await resources()];
  let runs: RunView[] = [];
  let before: string | undefined;
  let logBefore: number | null = null;
  let eventBefore: number | null = null;
  let executionKey: string | undefined;
  let index = 0;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const windowStart = new Date(Date.now() - 24 * 3600_000).toISOString();
  const windowEnd = new Date(Date.now() + 3600_000).toISOString();

  const measure = createMeasure(options.request, samples);

  const plan = [
    () =>
      measure("runs.latest", "/runs?limit=50", routes.runs.response, (value) => {
        runs = value;
        const last = value.at(-1);
        before = last ? encodeRunCursor(last) : undefined;

        return { items: value.length };
      }),
    () =>
      measure("loopies.counts", "/loopies", routes.loopies.response, (value) => ({
        items: value.length,
        runs: value.reduce(
          (sum, loopy) => sum + Object.values(loopy.counts).reduce((a, b) => a + b, 0),
          0,
        ),
      })),
    () =>
      measure("runs.waiting", "/runs?waiting=true&limit=50", routes.runs.response, (v) => ({
        items: v.length,
      })),
    () =>
      measure("runs.failed", "/runs?status=failed&limit=50", routes.runs.response, (v) => ({
        items: v.length,
      })),
    () =>
      measure(
        "overview.counts",
        `/overview?${new URLSearchParams({ from: windowStart, to: windowEnd })}`,
        routes.overview.response,
        (v) => ({ ...v.counts, buckets: v.buckets.length }),
      ),
    () =>
      measure("logs.latest", "/logs?limit=50", routes.globalLogs.response, (v) => {
        logBefore = v.next;

        return { items: v.items.length, scanned: v.scanned, hasMore: v.hasMore };
      }),
    () =>
      measure("events.latest", "/event-history?limit=50", routes.eventHistory.response, (v) => {
        eventBefore = v.next;

        return { items: v.items.length, scanned: v.scanned, hasMore: v.hasMore };
      }),
    () =>
      measure("daemon", "/daemon", routes.daemon.response, (v) => ({
        running: v.running,
        concurrency: v.concurrency,
      })),
    () => {
      const query = new URLSearchParams({ limit: "50" });

      if (before) {
        query.set("before", before);
      }

      return measure("runs.page2", `/runs?${query}`, routes.runs.response, (v) => ({
        items: v.length,
        cursorSupplied: before !== undefined,
      }));
    },
    () => {
      const query = new URLSearchParams({ limit: "50" });

      if (runs[0]) {
        query.set("slug", runs[0].slug);
      }

      return measure("runs.slug", `/runs?${query}`, routes.runs.response, (v) => ({
        items: v.length,
        filterSupplied: runs[0] !== undefined,
      }));
    },
    () =>
      measure("logs.text", "/logs?text=playground&limit=50", routes.globalLogs.response, (v) => ({
        items: v.items.length,
        scanned: v.scanned,
        hasMore: v.hasMore,
      })),
    () =>
      measure(
        "events.run-filter",
        "/event-history?entity=run&limit=50",
        routes.eventHistory.response,
        (v) => ({ items: v.items.length, scanned: v.scanned, hasMore: v.hasMore }),
      ),
    () =>
      measure(
        "logs.page2",
        `/logs?limit=50${logBefore === null ? "" : `&before=${logBefore}`}`,
        routes.globalLogs.response,
        (v) => ({
          items: v.items.length,
          scanned: v.scanned,
          hasMore: v.hasMore,
          cursorSupplied: logBefore !== null,
        }),
      ),
    () =>
      measure(
        "events.page2",
        `/event-history?limit=50${eventBefore === null ? "" : `&before=${eventBefore}`}`,
        routes.eventHistory.response,
        (v) => ({
          items: v.items.length,
          scanned: v.scanned,
          hasMore: v.hasMore,
          cursorSupplied: eventBefore !== null,
        }),
      ),
    async () => {
      const run = runs[index % Math.max(1, runs.length)];

      if (run) {
        await measure("run.snapshot", `/runs/${run.id}`, routes.run.response, (v) => ({
          nodes: v.nodeRuns.length,
          hooks: v.hooks.length,
          status: v.run.status,
        }));
      }
    },
    async () => {
      const run = runs[0];

      if (run) {
        await measure("run.payload", `/runs/${run.id}/payload`, routes.runPayload.response);
      }
    },
    async () => {
      const run = runs[0];

      if (run) {
        await measure(
          "execution.page",
          `/runs/${run.id}/executions?limit=50`,
          routes.executions.response,
          (v) => {
            executionKey = v.items[0] ? executionKeyString(v.items[0].key) : undefined;

            return { items: v.items.length, hasMore: v.next !== null };
          },
        );
      }
    },
    async () => {
      const run = runs[0];

      if (run && executionKey) {
        await measure(
          "execution.detail",
          `/runs/${run.id}/execution?${new URLSearchParams({ key: executionKey })}`,
          routes.execution.response,
          (v) => ({ attempts: v.attempts.length, status: v.node.status }),
        );
      }
    },
  ];

  async function save() {
    await options.save({
      scope: "local-playground-read-only-api",
      phase: options.phase,
      startedAt,
      updatedAt: new Date().toISOString(),
      elapsedMs: performance.now() - start,
      targetRequestsPerSecond: options.requestsPerSecond,
      samples,
      summaries: summarize(samples),
      resources: resourceSamples,
      limits: [
        "Sequential requests; no catch-up burst.",
        "Latency ends after body read, schema parse timed separately.",
        "No response payloads, hook tokens or credentials saved.",
        "Host resources include unrelated work; sampler CPU is not server CPU.",
      ],
    });
    options.onProgress?.({
      phase: options.phase,
      samples: samples.length,
      failures: samples.filter((sample) => sample.failure !== null).length,
      elapsedMs: performance.now() - start,
    });
  }

  while (performance.now() - start < options.seconds * 1000 && !options.shouldStop?.()) {
    const tick = performance.now();
    await plan[index % plan.length]?.();
    index++;

    if (index % plan.length === 0) {
      resourceSamples.push(await resources());
      await save();
    }

    await Bun.sleep(Math.max(0, 1000 / options.requestsPerSecond - (performance.now() - tick)));
  }

  resourceSamples.push(await resources());
  await save();

  return {
    phase: options.phase,
    samples: samples.length,
    failures: samples.filter((s) => s.failure !== null).length,
  };
}
