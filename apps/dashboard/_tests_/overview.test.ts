import { expect, test } from "bun:test";
import type { RunView } from "loopy/contract";
import { type ActiveStatus, mergeActiveRuns } from "../src/lib/overview.ts";

const queued = {
  id: "run-a",
  slug: "triage",
  workspace: "/work",
  loopy: { slug: "triage", description: null },
  input: null,
  createdAt: "2026-10-17T10:00:00.000Z",
  updatedAt: "2026-10-17T10:00:00.000Z",
  owner: null,
  ownerStale: false,
  waitingOn: null,
  status: "queued",
} satisfies RunView;

/** Active statuses only: queued and running share one shape, suspended adds its wake time. */
function run(id: string, status: ActiveStatus, createdAt: string, updatedAt = createdAt): RunView {
  const times = { id, createdAt, updatedAt };

  return status === "suspended"
    ? { ...queued, ...times, status, wakeAt: null }
    : { ...queued, ...times, status };
}

test("a run held by two status lists keeps only its most recently updated copy", () => {
  const staleQueued = run("run-a", "queued", "2026-10-17T10:00:00.000Z");
  const running = run("run-a", "running", "2026-10-17T10:00:00.000Z", "2026-10-17T10:00:05.000Z");

  for (const lists of [
    [[running], [staleQueued], []],
    [[], [staleQueued], [running]],
  ]) {
    expect(mergeActiveRuns(lists)).toEqual([running]);
  }
});

test("merged runs order by status, running first, then oldest first within a status", () => {
  const suspended = run("run-s", "suspended", "2026-10-17T09:00:00.000Z");
  const newerQueued = run("run-q2", "queued", "2026-10-17T10:05:00.000Z");
  const olderQueued = run("run-q1", "queued", "2026-10-17T10:01:00.000Z");
  const running = run("run-r", "running", "2026-10-17T10:10:00.000Z");

  const merged = mergeActiveRuns([[suspended], [newerQueued, olderQueued], [running]]);

  expect(merged.map(({ id }) => id)).toEqual(["run-r", "run-q1", "run-q2", "run-s"]);
});
