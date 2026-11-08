import { distribution } from "../../shared/stats";
import { evidence, state } from "../config";
import { groups, journalDirectory, readAdmissions, readEvents } from "../journal";
import { planTotals } from "../plan";
import { catalogs } from "../repository";
import { captureArtifact, readArtifact, segmentsArtifact, writeArtifact } from "./artifacts";
import { summarize } from "./statistics";

const continuous = await readArtifact(evidence, captureArtifact("during-load"));

const admissions = await readAdmissions(journalDirectory(state), "primary");

const plan = planTotals(await catalogs());

const groupTimes = [];

for (const group of groups) {
  const terminalTimes: string[] = [];

  for (const event of (await readEvents(state, group, "strict")).values) {
    if (event.kind === "terminal" && event.phase === "primary") {
      terminalTimes.push(event.terminalAt);
    }
  }

  const groupAdmissions = admissions.filter((item) => item.group === group);
  groupTimes.push({
    group,
    intentAt: groupAdmissions.map((item) => item.intentAt).sort()[0] ?? null,
    admittedAt:
      groupAdmissions
        .flatMap((item) => (item.admittedAt === null ? [] : [item.admittedAt]))
        .sort()[0] ?? null,
    terminalAt: terminalTimes.sort().at(-1) ?? null,
    admitted: groupAdmissions.length,
    terminal: terminalTimes.length,
  });
}

const firstIntent = groupTimes
  .flatMap((group) => (group.intentAt ? [group.intentAt] : []))
  .sort()[0];

const finishes = groupTimes
  .flatMap((group) => (group.terminalAt ? [{ group: group.group, at: group.terminalAt }] : []))
  .sort((a, b) => a.at.localeCompare(b.at));

const lastTerminal = finishes.at(-1)?.at;

if (
  !firstIntent ||
  !lastTerminal ||
  admissions.length !== plan.primary.runs ||
  finishes.length !== groups.length
) {
  throw new Error(
    `Segment analysis requires the completed ${plan.primary.runs}-primary-run journals.`,
  );
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

await writeArtifact(evidence, segmentsArtifact, {
  scope: "timestamp-derived-segments-of-preserved-continuous-capture",
  at: new Date().toISOString(),
  firstIntent,
  lastTerminal,
  groups: groupTimes,
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
  `${JSON.stringify({ firstIntent, lastTerminal, groups: groupTimes, segments: segments.map(({ name, samples, failures, endToEndMs }) => ({ name, samples, failures, endToEndMs })) })}\n`,
);
