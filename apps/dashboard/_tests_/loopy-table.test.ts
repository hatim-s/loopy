import { expect, test } from "bun:test";
import { emptyRunCounts, type LoopyView } from "@loopy/contract";
import { loopyInWorkspace } from "../src/lib/loopy-table";

function row(workspace: string, scope: LoopyView["scope"], description: string): LoopyView {
  return {
    slug: "deploy",
    workspace,
    description,
    scope,
    mode: "sandbox",
    input: {},
    schedule: null,
    lastRun: null,
    counts: emptyRunCounts(),
    latestRuns: [],
  };
}

test("a project loopy shadows the global one with its slug, whatever the list order", () => {
  // The service names the global row after the first workspace that lists it.
  const global = row("/work/b", "global", "global");
  const project = row("/work/a", "project", "project a");

  expect(loopyInWorkspace([global, project], "deploy", "/work/a")).toBe(project);
  expect(loopyInWorkspace([project, global], "deploy", "/work/a")).toBe(project);
  expect(loopyInWorkspace([global, project], "deploy", "/work/c")).toBe(global);
  expect(loopyInWorkspace([project], "deploy", "/work/c")).toBeUndefined();
});
