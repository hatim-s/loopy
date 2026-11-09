import {
  type Route,
  type RouteInput,
  type RouteResult,
  type RunView,
  routes,
} from "@loopy/contract";
import { executionKeyString } from "@loopy/core";
import type { PlaygroundClient } from "../client";
import { evidence } from "../config";
import { CONCURRENCY } from "../plan";
import { captureArtifact, writeArtifact } from "./artifacts";
import { createMeasure } from "./request";
import { resources } from "./resources";
import { type Sample, summarize } from "./statistics";

// Per-run detail requests are conditional and cannot be required before the first workload.
export const baselineEndpoints = [
  "runs.latest",
  "loopies.counts",
  "runs.waiting",
  "runs.failed",
  "overview.counts",
  "logs.latest",
  "events.latest",
  "daemon",
  "runs.page2",
  "runs.slug",
  "logs.text",
  "events.run-filter",
  "logs.page2",
  "events.page2",
] as const;

type Endpoint =
  | (typeof baselineEndpoints)[number]
  | "run.snapshot"
  | "run.payload"
  | "execution.page"
  | "execution.detail";

/** Samples the read API at a fixed rate and rewrites the phase's capture artifact each cycle. */
export async function sampleApi(
  client: PlaygroundClient,
  options: { phase: string; seconds: number; requestsPerSecond: number; shouldStop: () => boolean },
) {
  const artifact = captureArtifact(options.phase);
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

  const measureAny = createMeasure((path, signal) => client.request(path, { signal }), samples);

  const measure = <R extends Route>(
    endpoint: Endpoint,
    route: R,
    input: RouteInput<R>,
    observe?: (value: RouteResult<R>) => Sample["observation"],
  ) => measureAny(endpoint, route, input, observe);

  const page = { limit: 50 };

  const plan = [
    () =>
      measure("runs.latest", routes.runs, { query: page }, (value) => {
        runs = value.runs;
        before = value.next ?? undefined;

        return { items: value.runs.length };
      }),
    () =>
      measure("loopies.counts", routes.loopies, {}, (value) => ({
        items: value.length,
        runs: value.reduce(
          (sum, loopy) => sum + Object.values(loopy.counts).reduce((a, b) => a + b, 0),
          0,
        ),
      })),
    () =>
      measure("runs.waiting", routes.runs, { query: { ...page, waiting: true } }, (v) => ({
        items: v.runs.length,
      })),
    () =>
      measure("runs.failed", routes.runs, { query: { ...page, status: "failed" } }, (v) => ({
        items: v.runs.length,
      })),
    () =>
      measure(
        "overview.counts",
        routes.overview,
        { query: { from: windowStart, to: windowEnd } },
        (v) => ({ ...v.counts, buckets: v.buckets.length }),
      ),
    () =>
      measure("logs.latest", routes.globalLogs, { query: page }, (v) => {
        logBefore = v.next;

        return { items: v.items.length, scanned: v.scanned, hasMore: v.hasMore };
      }),
    () =>
      measure("events.latest", routes.eventHistory, { query: page }, (v) => {
        eventBefore = v.next;

        return { items: v.items.length, scanned: v.scanned, hasMore: v.hasMore };
      }),
    () =>
      measure("daemon", routes.daemon, {}, (v) => ({
        running: v.running,
        concurrency: v.concurrency,
      })),
    () =>
      measure("runs.page2", routes.runs, { query: { ...page, before } }, (v) => ({
        items: v.runs.length,
        cursorSupplied: before !== undefined,
      })),
    () =>
      measure("runs.slug", routes.runs, { query: { ...page, slug: runs[0]?.slug } }, (v) => ({
        items: v.runs.length,
        filterSupplied: runs[0] !== undefined,
      })),
    () =>
      measure("logs.text", routes.globalLogs, { query: { ...page, text: "playground" } }, (v) => ({
        items: v.items.length,
        scanned: v.scanned,
        hasMore: v.hasMore,
      })),
    () =>
      measure(
        "events.run-filter",
        routes.eventHistory,
        { query: { ...page, entity: "run" } },
        (v) => ({ items: v.items.length, scanned: v.scanned, hasMore: v.hasMore }),
      ),
    () =>
      measure(
        "logs.page2",
        routes.globalLogs,
        { query: { ...page, before: logBefore ?? undefined } },
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
        routes.eventHistory,
        { query: { ...page, before: eventBefore ?? undefined } },
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
        await measure("run.snapshot", routes.run, { params: { id: run.id } }, (v) => ({
          nodes: v.nodeRuns.length,
          hooks: v.hooks.length,
          status: v.run.status,
        }));
      }
    },
    async () => {
      const run = runs[0];

      if (run) {
        await measure("run.payload", routes.runPayload, { params: { id: run.id } });
      }
    },
    async () => {
      const run = runs[0];

      if (run) {
        await measure(
          "execution.page",
          routes.executions,
          { params: { id: run.id }, query: page },
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
          routes.execution,
          { params: { id: run.id }, query: { key: executionKey } },
          (v) => ({ attempts: v.attempts.length, status: v.node.status }),
        );
      }
    },
  ];

  async function save() {
    await writeArtifact(evidence, artifact, {
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
      api: client.settings.api,
      dashboard: client.settings.dashboard,
      batch: client.settings.batch,
      workspace: client.settings.workspace,
      workloadControls: { apiSlots: CONCURRENCY, runtimeAttempts: CONCURRENCY },
    });
    process.stdout.write(
      `${JSON.stringify({
        status: "progress",
        phase: options.phase,
        samples: samples.length,
        failures: samples.filter((sample) => sample.failure !== null).length,
        elapsedMs: performance.now() - start,
      })}\n`,
    );
  }

  while (performance.now() - start < options.seconds * 1000 && !options.shouldStop()) {
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
