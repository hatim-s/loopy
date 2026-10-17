import { expect, test } from "bun:test";
import type { LogRecord, StepRecord } from "loopy/contract";
import { groupTimeline } from "../src/lib/timeline.ts";

function step(seq: number): StepRecord {
  return {
    runId: "run",
    seq,
    key: `step-${seq}`,
    kind: "function",
    input: null,
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-10-17T00:00:00Z",
    status: "running",
  };
}

function log(seq: number, position: LogRecord["position"]): LogRecord {
  return {
    runId: "run",
    seq,
    position,
    level: "info",
    message: `log-${seq}`,
    at: "2026-10-17T00:00:00Z",
  };
}

test("timeline orders steps and logs by sequence without changing its inputs", () => {
  const steps = [step(2), step(1)];

  const logs = [
    log(5, { kind: "workflow", afterStep: 2, afterFinish: 1, index: 0 }),
    log(4, { kind: "workflow", afterStep: 1, afterFinish: 2, index: 0 }),
    log(3, { kind: "step", seq: 1, attempt: 2, index: 0 }),
    log(2, { kind: "step", seq: 1, attempt: 1, index: 0 }),
    log(1, { kind: "workflow", afterStep: 0, afterFinish: 0, index: 0 }),
  ];

  const timeline = groupTimeline(steps, logs);
  expect(timeline.before.map((entry) => entry.seq)).toEqual([1]);
  expect(timeline.steps.map((entry) => entry.step.seq)).toEqual([1, 2]);
  expect(timeline.steps.map((entry) => entry.logs.map((item) => item.seq))).toEqual([[2, 3], []]);
  expect(timeline.steps.map((entry) => entry.after.map((item) => item.seq))).toEqual([[4], [5]]);
  expect(steps.map((entry) => entry.seq)).toEqual([2, 1]);
  expect(logs.map((entry) => entry.seq)).toEqual([5, 4, 3, 2, 1]);
});

test("empty traces have no timeline entries", () => {
  expect(groupTimeline([], [])).toEqual({ before: [], steps: [] });
});
