import { expect, test } from "bun:test";
import type { RunView } from "loopy/contract";
import { inboxGroups } from "../src/lib/inbox.ts";

function run(id: string, slug: string, updatedAt: string, waiting: boolean): RunView {
  return {
    id,
    slug,
    workspace: "/work",
    loopy: { slug, description: null },
    input: null,
    createdAt: "2026-10-17T09:00:00.000Z",
    updatedAt,
    owner: null,
    ownerStale: false,
    waitingOn: waiting ? { hook: "approve", token: `tok-${id}`, seq: 1, expiresAt: null } : null,
    status: "suspended",
    wakeAt: null,
  };
}

test("the inbox keeps waiting runs, grouped by loopy, oldest wait first", () => {
  const groups = inboxGroups([
    run("a3", "deploy", "2026-10-17T10:03:00.000Z", true),
    run("b1", "triage", "2026-10-17T10:02:00.000Z", true),
    run("a1", "deploy", "2026-10-17T10:01:00.000Z", true),
    run("s1", "triage", "2026-10-17T10:00:00.000Z", false),
    run("b2", "triage", "2026-10-17T10:04:00.000Z", true),
  ]);

  expect(groups.map((group) => [group.slug, group.runs.map((item) => item.id)])).toEqual([
    ["deploy", ["a1", "a3"]],
    ["triage", ["b1", "b2"]],
  ]);
});

test("suspended runs that only sleep leave the inbox empty", () => {
  expect(inboxGroups([run("s1", "triage", "2026-10-17T10:00:00.000Z", false)])).toEqual([]);
});
