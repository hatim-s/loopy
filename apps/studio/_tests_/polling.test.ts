import { expect, test } from "bun:test";
import type { RunStatus } from "loopy";
import { nextPollDelay } from "../src/lib/polling.ts";

const now = Date.parse("2026-10-17T00:00:00Z");

const statuses: RunStatus[] = [
  "queued",
  "running",
  "suspended",
  "succeeded",
  "failed",
  "cancelled",
];

test("hidden documents pause polling for every run status", () => {
  for (const status of statuses) {
    expect(nextPollDelay({ status }, false, now)).toBeUndefined();
  }
});

test("active runs poll and terminal runs stop", () => {
  for (const status of statuses) {
    expect(nextPollDelay({ status }, true, now)).toBe(
      status === "suspended"
        ? 10_000
        : status === "queued" || status === "running"
          ? 2000
          : undefined,
    );
  }
});

test("suspended runs detect cancellation within ten seconds and wake sooner when due", () => {
  const cases: [number, number][] = [
    [60_000, 10_000],
    [500, 500],
    [0, 2000],
    [-500, 2000],
  ];

  for (const [offset, expected] of cases) {
    const wakeAt = new Date(now + offset).toISOString();
    expect(nextPollDelay({ status: "suspended", wakeAt }, true, now)).toBe(expected);
  }
});
