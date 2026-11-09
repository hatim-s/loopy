import { resolve } from "node:path";
import { boundaryOptions } from "@loopy/contract";
import { Result, Schema } from "effect";
import { distribution } from "../../shared/stats";
import { evidence, state } from "../config";
import { atomic } from "../files";
import { type RuntimeQueueEntry, runtimeQueuePath, runtimeQueueSchema } from "../runtime-queue";
import { captureArtifact, readArtifact, segmentsArtifact } from "./artifacts";
import { countBy } from "./statistics";

const { firstIntent, lastTerminal } = await readArtifact(evidence, segmentsArtifact);

const boundary = { firstIntent, lastTerminal };

const decodeQueue = Schema.decodeUnknownResult(runtimeQueueSchema, boundaryOptions);

const queue: RuntimeQueueEntry[] = [];

let invalidQueueLines = 0;

for (const line of (await Bun.file(runtimeQueuePath(state)).text()).trim().split("\n")) {
  const parsed = decodeQueue(JSON.parse(line));

  if (Result.isFailure(parsed)) {
    invalidQueueLines++;
  } else if (parsed.success.queuedAt >= firstIntent && parsed.success.queuedAt <= lastTerminal) {
    queue.push(parsed.success);
  }
}

const resources = (await readArtifact(evidence, captureArtifact("during-load"))).resources.filter(
  (sample) => sample.at >= firstIntent && sample.at <= lastTerminal,
);

const processes = resources.flatMap((sample) =>
  (sample.processes ?? []).map((row) => ({ at: sample.at, ...row })),
);

const processSummary = [...new Set(processes.map((sample) => sample.command))].map((command) => {
  const selected = processes.filter((sample) => sample.command === command);

  return {
    command,
    observations: selected.length,
    lifetimeAverageCpuPercent: distribution(selected.map((sample) => sample.cpuPercent)),
    rssKiB: distribution(selected.map((sample) => sample.rssKiB)),
  };
});

const value = {
  scope: "primary-load-runtime-and-host-context",
  at: new Date().toISOString(),
  ...boundary,
  completedBackendStarts: queue.length,
  invalidQueueLines,
  backendQueueWaitMs: distribution(queue.map((record) => record.queueWaitMs)),
  backendDurationMs: distribution(queue.map((record) => record.backendDurationMs)),
  backendOutcomes: countBy(queue, (record) => record.outcome),
  resourceSamples: resources.length,
  host: {
    cpuCount: resources[0]?.host.cpus ?? null,
    totalBytes: resources[0]?.host.totalBytes ?? null,
    freeBytes: distribution(resources.map((sample) => sample.host.freeBytes)),
    oneMinuteLoad: distribution(
      resources.flatMap((sample) =>
        sample.host.load[0] === undefined ? [] : [sample.host.load[0]],
      ),
    ),
  },
  processSummary,
  diskFirst: resources[0]?.disk ?? null,
  diskLast: resources.at(-1)?.disk ?? null,
  queue,
  limits: [
    "Backend records count completed provider starts,not workflow runs or control nodes. Outcome execution includes intentionally failing fixtures.",
    "Queue wait is the provider's separate four-attempt semaphore,not the shared client's API slots.",
    "Backend duration includes Docker launch,execution and receipt work; it is not pure command CPU.",
    "ps CPU is a lifetime average; RSS values are KiB. Observed maxima are sampled host-process context,not CPU utilization over fixed intervals.",
    "Host load/free memory include unrelated work. Docker guest/container CPU and memory peaks are not measured by these host snapshots.",
  ],
};

atomic(resolve(evidence, "playground-performance-runtime.json"), value);

process.stdout.write(
  `${JSON.stringify({ completedBackendStarts: value.completedBackendStarts, backendQueueWaitMs: value.backendQueueWaitMs, backendDurationMs: value.backendDurationMs, backendOutcomes: value.backendOutcomes, resourceSamples: value.resourceSamples, invalidQueueLines })}\n`,
);
