import { resolve } from "node:path";
import { boundaryOptions } from "@loopy/contract";
import { Result, Schema } from "effect";
import { z } from "zod";
import { atomic, evidenceDirectory, state } from "../config";
import { runtimeQueueSchema } from "../runtime-queue-schema";
import { distribution } from "./statistics";

const boundary = z
  .object({ firstIntent: z.string(), lastTerminal: z.string() })
  .parse(await Bun.file(resolve(evidenceDirectory, "playground-performance-segments.json")).json());

const queue: Schema.Schema.Type<typeof runtimeQueueSchema>[] = [];

let invalidQueueLines = 0;

for (const line of (await Bun.file(resolve(state, "runtime-queue.jsonl")).text())
  .trim()
  .split("\n")) {
  const parsed = Schema.decodeUnknownResult(runtimeQueueSchema, boundaryOptions)(JSON.parse(line));

  if (Result.isSuccess(parsed)) {
    if (
      parsed.success.queuedAt >= boundary.firstIntent &&
      parsed.success.queuedAt <= boundary.lastTerminal
    ) {
      queue.push(parsed.success);
    }
  } else {
    invalidQueueLines++;
  }
}

const resourceSchema = z.object({
  at: z.string(),
  processes: z.string().nullable(),
  disk: z.string().nullable(),
  host: z.object({
    cpus: z.number(),
    freeBytes: z.number(),
    totalBytes: z.number(),
    load: z.array(z.number()),
  }),
});

const continuous = z
  .object({ resources: z.array(resourceSchema) })
  .parse(
    await Bun.file(resolve(evidenceDirectory, "playground-performance-during-load.json")).json(),
  );

const resources = continuous.resources.filter(
  (sample) => sample.at >= boundary.firstIntent && sample.at <= boundary.lastTerminal,
);

const processSchema = z.object({
  pid: z.coerce.number().int(),
  ppid: z.coerce.number().int(),
  cpuPercent: z.coerce.number().nonnegative(),
  rssKiB: z.coerce.number().nonnegative(),
});

const processes: (z.infer<typeof processSchema> & { at: string; command: string })[] = [];

let invalidProcessRows = 0;

for (const sample of resources) {
  for (const row of sample.processes?.split("\n") ?? []) {
    const columns = row.trim().split(/\s+/);

    const parsed = processSchema.safeParse({
      pid: columns[0],
      ppid: columns[1],
      cpuPercent: columns[2],
      rssKiB: columns[3],
    });

    if (!parsed.success) {
      invalidProcessRows++;
      continue;
    }

    processes.push({ at: sample.at, ...parsed.data, command: columns.slice(6).join(" ") });
  }
}

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
  backendOutcomes: Object.fromEntries(
    [...new Set(queue.map((record) => record.outcome))].map((outcome) => [
      outcome,
      queue.filter((record) => record.outcome === outcome).length,
    ]),
  ),
  resourceSamples: resources.length,
  invalidProcessRows,
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

await atomic(resolve(evidenceDirectory, "playground-performance-runtime.json"), value);

process.stdout.write(
  `${JSON.stringify({ completedBackendStarts: value.completedBackendStarts, backendQueueWaitMs: value.backendQueueWaitMs, backendDurationMs: value.backendDurationMs, backendOutcomes: value.backendOutcomes, resourceSamples: value.resourceSamples, invalidQueueLines, invalidProcessRows })}\n`,
);
