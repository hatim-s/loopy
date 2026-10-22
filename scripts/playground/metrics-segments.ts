import { resolve } from "node:path";
import { z } from "zod";
import { atomic, root, state } from "./config.js";
import { admissionSchema } from "./journal.js";
import { distribution, type Sample, summarize } from "./metrics-statistics.js";

const terminalSchema = z.object({
  kind: z.string(),
  phase: z.string().optional(),
  runId: z.string().optional(),
  terminalAt: z.string().optional(),
});

const sampleSchema: z.ZodType<Sample> = z.object({
  endpoint: z.string(),
  at: z.string(),
  status: z.number().nullable(),
  bytes: z.number(),
  headersMs: z.number().nullable(),
  totalMs: z.number(),
  parseMs: z.number().nullable(),
  failure: z.enum(["transport", "schema", "http", "body_limit"]).nullable(),
  observation: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

const continuousSchema = z.object({
  startedAt: z.string(),
  updatedAt: z.string(),
  samples: z.array(sampleSchema),
});

const continuous = continuousSchema.parse(
  await Bun.file(
    resolve(root, ".notes/cloud/evidence/playground-performance-during-load.json"),
  ).json(),
);

const admissions = [];

for await (const path of new Bun.Glob("primary/*/*.json").scan({
  cwd: resolve(state, "journal"),
  absolute: true,
})) {
  if (!path.endsWith(".progress.json")) {
    admissions.push(admissionSchema.parse(await Bun.file(path).json()));
  }
}

const groups = [];

for (const group of ["a", "b", "c"] as const) {
  const terminalTimes: string[] = [];

  for (const line of (await Bun.file(resolve(state, "journal", `${group}.jsonl`)).text())
    .trim()
    .split("\n")) {
    const event = terminalSchema.parse(JSON.parse(line));

    if (event.kind === "terminal" && event.phase === "primary" && event.terminalAt) {
      terminalTimes.push(event.terminalAt);
    }
  }

  const groupAdmissions = admissions.filter((item) => item.group === group);
  groups.push({
    group,
    intentAt: groupAdmissions.map((item) => item.intentAt).sort()[0],
    admittedAt: groupAdmissions
      .flatMap((item) => (item.admittedAt === null ? [] : [item.admittedAt]))
      .sort()[0],
    terminalAt: terminalTimes.sort().at(-1),
    admitted: groupAdmissions.length,
    terminal: terminalTimes.length,
  });
}

const firstIntent = groups.flatMap((group) => (group.intentAt ? [group.intentAt] : [])).sort()[0];

const finishes = groups
  .flatMap((group) => (group.terminalAt ? [{ group: group.group, at: group.terminalAt }] : []))
  .sort((a, b) => a.at.localeCompare(b.at));

const lastTerminal = finishes.at(-1)?.at;

if (!firstIntent || !lastTerminal || admissions.length !== 525 || finishes.length !== 3) {
  throw new Error("Segment analysis requires the completed 525-primary-run journals.");
}

const failureTimes = continuous.samples
  .filter((sample) => sample.failure !== null)
  .map((sample) => sample.at)
  .sort();

const firstFailure = failureTimes[0];

const lastFailure = failureTimes.at(-1);

const recovery = lastFailure
  ? continuous.samples.find((sample) => sample.at > lastFailure && sample.failure === null)?.at
  : undefined;

const windows: { name: string; from: string; to: string }[] = [
  { name: "primary-all", from: firstIntent, to: lastTerminal },
  { name: "after-terminal-before-root-stop", from: lastTerminal, to: continuous.updatedAt },
];

if (firstFailure && recovery) {
  windows.push(
    { name: "prelaunch-before-refresh", from: continuous.startedAt, to: firstFailure },
    { name: "authorized-prelaunch-refresh", from: firstFailure, to: recovery },
    { name: "prelaunch-after-refresh", from: recovery, to: firstIntent },
  );
}

let previous = firstIntent;

for (let index = 0; index < finishes.length; index++) {
  const finish = finishes[index];

  if (finish) {
    windows.push({
      name: `primary-transition-${index + 1}-through-${finish.group}-terminal`,
      from: previous,
      to: finish.at,
    });
    previous = finish.at;
  }
}

const segments = windows.map((window) => {
  const selected = continuous.samples.filter(
    (sample) => sample.at >= window.from && sample.at < window.to,
  );

  return {
    ...window,
    elapsedMs: Date.parse(window.to) - Date.parse(window.from),
    samples: selected.length,
    failures: selected.filter((sample) => sample.failure !== null).length,
    endToEndMs: distribution(selected.map((sample) => sample.totalMs)),
    endpoints: summarize(selected),
  };
});

await atomic(resolve(root, ".notes/cloud/evidence/playground-performance-segments.json"), {
  scope: "timestamp-derived-segments-of-preserved-continuous-capture",
  at: new Date().toISOString(),
  firstIntent,
  lastTerminal,
  groups,
  samplerFinalSavedAt: continuous.updatedAt,
  segments,
  measurement:
    "Client-observed end-to-end, includes filesystem API semaphore/40ms polling and HTTP/body work; headersMs is not TTFB.",
  limits: [
    "Windows assign requests by their start timestamp; a body may finish after the window boundary.",
    "Transition boundaries use final durable run.updatedAt from terminal journal events, not later driver summary writes.",
    "All original requests,including prelaunch outlier and restart failures,remain in the raw continuous capture.",
    "Aggregate percentiles combine endpoint variants; use per-endpoint summaries for comparison.",
    "After-terminal-before-root-stop includes root browser verification and is not the controlled 90second post-load capture.",
  ],
});

process.stdout.write(
  `${JSON.stringify({ firstIntent, lastTerminal, groups, segments: segments.map(({ name, samples, failures, endToEndMs }) => ({ name, samples, failures, endToEndMs })) })}\n`,
);
