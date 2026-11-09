import { resolve } from "node:path";
import { isTerminalRun, routes } from "@loopy/contract";
import { PlaygroundClient } from "../client";
import { evidence } from "../config";
import { atomic } from "../files";
import { decodePhaseName } from "./artifacts";
import { createMeasure } from "./request";
import { type Sample, summarize } from "./statistics";

const phase = decodePhaseName(process.argv[2]);

const output = resolve(evidence, `playground-performance-${phase}.json`);

if (await Bun.file(output).exists()) {
  throw new Error("Matched evidence exists. Choose a new phase to preserve the earlier segment.");
}

const client = await PlaygroundClient.open();

const samples: Sample[] = [];

const pairs: {
  route: string;
  iteration: number;
  order: string[];
  startedAt: string;
  endedAt: string;
}[] = [];

const startedAt = new Date().toISOString();

let previousStart = 0;

const direct = createMeasure(
  (path, signal) =>
    fetch(`${client.settings.api}${path}`, {
      headers: { Authorization: `Bearer ${client.settings.token}` },
      signal,
    }),
  samples,
);

const shared = createMeasure((path, signal) => client.request(path, signal), samples);

async function probe(route: "runs" | "loopies" | "events", mode: "direct" | "shared") {
  await Bun.sleep(Math.max(0, 1000 - (performance.now() - previousStart)));
  previousStart = performance.now();
  const measure = mode === "direct" ? direct : shared;
  const label = `${route}.${mode}`;

  if (route === "runs") {
    await measure(label, routes.runs, { query: { limit: 50 } }, (value) => ({
      items: value.length,
      queued: value.filter((run) => run.status === "queued").length,
      running: value.filter((run) => run.status === "running").length,
      terminal: value.filter((run) => isTerminalRun(run.status)).length,
    }));
  } else if (route === "loopies") {
    await measure(label, routes.loopies, {}, (value) => ({
      items: value.length,
      retainedRuns: value.reduce(
        (sum, loopy) => sum + Object.values(loopy.counts).reduce((a, b) => a + b, 0),
        0,
      ),
      running: value.reduce((sum, loopy) => sum + loopy.counts.running, 0),
      queued: value.reduce((sum, loopy) => sum + loopy.counts.queued, 0),
    }));
  } else {
    await measure(label, routes.eventHistory, { query: { limit: 50 } }, (value) => ({
      items: value.items.length,
      scanned: value.scanned,
      newest: value.newest,
      hasMore: value.hasMore,
    }));
  }
}

async function save() {
  atomic(output, {
    phase,
    scope: "local-read-only-matched-http-probe",
    startedAt,
    updatedAt: new Date().toISOString(),
    api: client.settings.api,
    workspace: client.settings.workspace,
    batch: client.settings.batch,
    plannedRequests: 36,
    maximumRequestsPerSecond: 1,
    maximumInFlight: 1,
    pairs,
    samples,
    summaries: summarize(samples),
    measurement: {
      direct:
        "headersMs timestamps direct fetch response before body consumption; totalMs includes HTTP transport and full body read.",
      shared:
        "headersMs and totalMs include filesystem API-slot acquisition,40ms polling,HTTP work and full-body buffering inside current PlaygroundClient; headersMs is not TTFB.",
    },
    limits: [
      "Direct reads bypass the four shared API slots and add at most one extra HTTP request concurrently with that shared pool.",
      "Pairs alternate ordering and use the same three exact paths, API origin, workspace credential and schemas.",
      "Data changes during active load; counts, event cursor and per-request timestamps expose those differences.",
      "Six samples per route and mode do not establish tail latency or statistical significance.",
      "Direct HTTP end-to-end timing still includes local transport and server scheduling; it is not pure SQL or server execution time.",
      "Each request has a15second abort signal and the measured body reader stops above8MiB. The unchanged shared client buffers before that reader, so its internal allocation is outside the probe's cap.",
      "Only statuses,bytes,timings and numeric observations are saved; no credentials,hook tokens or response payloads.",
    ],
  });
}

for (const route of ["runs", "loopies", "events"] as const) {
  for (let iteration = 0; iteration < 6; iteration++) {
    const pairStart = new Date().toISOString();

    const order =
      iteration % 2 === 0 ? (["direct", "shared"] as const) : (["shared", "direct"] as const);

    for (const mode of order) {
      await probe(route, mode);
    }

    pairs.push({
      route,
      iteration,
      order: [...order],
      startedAt: pairStart,
      endedAt: new Date().toISOString(),
    });
    await save();
  }
}

await save();

process.stdout.write(
  `${JSON.stringify({ phase, output, samples: samples.length, failures: samples.filter((sample) => sample.failure !== null).length })}\n`,
);
