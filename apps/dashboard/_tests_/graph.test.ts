import { expect, test } from "bun:test";
import {
  executionKeyString,
  graphRevisionViewSchema,
  type LogRecord,
  nodeRunViewSchema,
} from "loopy/contract";
import { demoScript } from "../src/backend/demo.ts";
import { RELEASE, REVIEW, TRIAGE_V1, TRIAGE_V2 } from "../src/backend/demo-graphs.ts";
import { executionLogs, focusNodes, graphModel } from "../src/lib/graph.ts";
import { graphGroups, layoutGraph } from "../src/lib/graph-layout.ts";
import { predicateText } from "../src/lib/graph-text.ts";

const AT = "2026-10-19T10:00:00.000Z";

function record(
  nodeId: string,
  status: "succeeded" | "failed" | "running" | "skipped",
  index?: number,
) {
  const base = {
    key: {
      runId: "run-1",
      nodeId,
      scope: index === undefined ? [] : [{ nodeId: "4:map", index }],
    },
    attempt: 1,
    maxAttempts: 3,
    startedAt: AT,
    receipt: "started",
  };

  return nodeRunViewSchema.parse(
    status === "succeeded"
      ? { ...base, status, output: null, endedAt: AT }
      : status === "failed"
        ? { ...base, status, error: { code: "exit", message: "boom" }, endedAt: AT }
        : status === "skipped"
          ? { ...base, status, endedAt: AT }
          : { ...base, status },
  );
}

function states(model: ReturnType<typeof graphModel>) {
  return Object.fromEntries(
    model.nodes.map((node) => [
      node.id,
      node.state.kind === "ran"
        ? node.state.status
        : node.state.kind === "idle"
          ? node.state.reason
          : node.state.kind,
    ]),
  );
}

test("a definition draws every compiled node and labels control edges", () => {
  const model = graphModel(REVIEW.graph, null);

  expect(model.nodes.map((node) => node.id)).toEqual(REVIEW.graph.nodes.map((node) => node.id));
  expect(new Set(Object.values(states(model)))).toEqual(new Set(["definition"]));
  expect(model.edges.map((edge) => [edge.from, edge.to, edge.label, edge.taken])).toContainEqual([
    "1:branch",
    "2:log",
    "yes",
    false,
  ]);
  expect(model.edges.find((edge) => edge.kind === "next")?.label).toBeNull();
  expect(model.orphans).toEqual([]);
});

test("nodes without a record never read as executed", () => {
  const stopped = graphModel(REVIEW.graph, {
    status: "failed",
    nodeRuns: [record("0:changes", "succeeded"), record("1:branch", "failed")],
  });

  expect(states(stopped)).toMatchObject({
    "0:changes": "succeeded",
    "1:branch": "failed",
    "2:log": "not_run",
    "4:diff": "not_run",
    "10:join": "not_run",
  });
  expect(stopped.edges.filter((edge) => edge.taken).map((edge) => edge.id)).toEqual([
    "0:changes->1:branch:next",
  ]);

  const active = graphModel(TRIAGE_V2.graph, { status: "running", nodeRuns: [] });
  expect(new Set(Object.values(states(active)))).toEqual(new Set(["not_started"]));
});

test("only a next edge from a succeeded node into a node that ran in its scope reads as taken", () => {
  const taken = (model: ReturnType<typeof graphModel>) =>
    model.edges.filter((edge) => edge.taken).map((edge) => edge.id);

  const review = graphModel(REVIEW.graph, {
    status: "succeeded",
    nodeRuns: [
      record("0:changes", "succeeded"),
      record("1:branch", "succeeded"),
      record("2:log", "succeeded"),
      record("3:join", "succeeded"),
      record("4:diff", "skipped"),
      record("5:prompt", "skipped"),
      record("9:join", "succeeded"),
      record("10:join", "skipped"),
    ],
  });

  // Branch arms and joins have records at both ends, but no record says which arm fired.
  expect(taken(review)).toEqual(["0:changes->1:branch:next", "2:log->3:join:next"]);

  const scoped = (index: number) =>
    graphModel(TRIAGE_V2.graph, {
      status: "running",
      nodeRuns: [record("1:classify", "succeeded", 0), record("2:log", "running", index)],
    });

  expect(taken(scoped(0))).toEqual(["1:classify->2:log:next"]);
  expect(taken(scoped(1))).toEqual([]);
});

test("scoped executions roll up to the most urgent status with counts", () => {
  const model = graphModel(TRIAGE_V2.graph, {
    status: "running",
    nodeRuns: [
      record("1:classify", "succeeded", 0),
      record("1:classify", "failed", 1),
      record("1:classify", "running", 2),
    ],
  });

  const classify = model.nodes.find((node) => node.id === "1:classify");

  expect(classify?.executions).toHaveLength(3);
  expect(classify?.state).toEqual({
    kind: "ran",
    status: "failed",
    counts: { succeeded: 1, failed: 1, running: 1 },
  });
});

test("records from another revision surface as orphans instead of attaching to nodes", () => {
  const pinned = demoScript().runs.find((run) => run.run.status === "succeeded");

  if (!pinned) {
    throw new Error("The demo script lost its pinned run.");
  }

  const run = { status: pinned.run.status, nodeRuns: pinned.nodeRuns };

  // The demo pins this run to the first revision; drawing it on the latest one must not fit.
  expect(graphModel(TRIAGE_V1.graph, run).orphans).toEqual([]);
  expect(graphModel(TRIAGE_V2.graph, run).orphans.map(({ key }) => key.nodeId.toString())).toEqual([
    "2:reply",
    "3:join",
  ]);
});

test("execution logs match the shared execution key and group by the attempt that wrote them", () => {
  const execution = record("1:classify", "succeeded", 0);
  const key = executionKeyString(execution.key);

  const log = (seq: number, executionKey: string, attempt: number): LogRecord => ({
    runId: "run-1",
    seq,
    position: { kind: "node", executionKey, attempt, index: 0 },
    level: "info",
    message: `log ${seq}`,
    at: AT,
  });

  const other = executionKeyString(record("1:classify", "succeeded", 1).key);

  expect(
    executionLogs(
      [log(1, key, 1), log(2, other, 1), log(3, key, 1), log(4, key, 2)],
      execution,
    ).map((group) => [group.attempt, group.logs.map((entry) => entry.seq)]),
  ).toEqual([
    [1, [1, 3]],
    [2, [4]],
  ]);
});

test("roles tell work, control, values and joins apart, and the top-level output join is the end", () => {
  const roles = Object.fromEntries(
    graphModel(REVIEW.graph, null).nodes.map((node) => [node.id, node.role]),
  );

  expect(roles).toMatchObject({
    "0:changes": "work",
    "1:branch": "control",
    "2:log": "value",
    "3:join": "junction",
    "9:join": "junction",
    "10:join": "end",
  });
});

test("control nodes read as text: predicates by label, shell commands by argv", () => {
  const nodes = new Map(
    graphModel(RELEASE.graph, null).nodes.map((node) => [String(node.id), node]),
  );

  const branch = REVIEW.graph.nodes.find((node) => node.kind === "branch");

  if (branch?.kind !== "branch") {
    throw new Error("The review fixture lost its branch.");
  }

  expect(predicateText(branch.predicate)).toBe("size(changes.stdout) ≤ 0");
  expect(nodes.get("2:branch")?.detail).toBe("if plan.dirty = true");
  expect(nodes.get("8:lint")?.detail).toBe("bun run lint");
  expect(nodes.get("15:map")?.detail).toBe("each plan.packages, 2 at a time");
  expect(nodes.get("3:fail")?.detail).toBe("The working tree has uncommitted changes.");
});

test("only control edges carry labels; sequence and join edges stay quiet", () => {
  const labels = new Map(
    graphModel(RELEASE.graph, null).edges.map((edge) => [`${edge.from}->${edge.to}`, edge.label]),
  );

  expect(labels.get("2:branch->3:fail")).toBe("yes");
  expect(labels.get("7:parallel->12:typecheck")).toBe("types");
  expect(labels.get("15:map->16:publish/build")).toBe("each");
  expect(labels.get("18:publish/rescue->21:publish/format")).toBe("rescue");
  expect(labels.get("34:finally->48:clean")).toBe("cleanup");
  expect(labels.get("26:join->15:map")).toBeNull();
  expect(labels.get("0:status->1:plan")).toBeNull();
});

test("frames nest scopes and subgraph calls: map, then the publish subgraph, then its rescue", () => {
  const { groups, parentOf } = graphGroups(graphModel(RELEASE.graph, null));
  const parents = Object.fromEntries(groups.map((group) => [group.id, group.parent]));

  expect(parents).toEqual({
    "scope:2:branch": null,
    "scope:7:parallel": null,
    "scope:15:map": null,
    "subgraph:publish@16": "scope:15:map",
    "scope:18:publish/rescue": "subgraph:publish@16",
    "scope:30:branch": null,
    "scope:34:finally": null,
    "scope:35:switch": "scope:34:finally",
  });

  // A control node sits in its own frame; the map's own join closes the subgraph call.
  expect(parentOf.get("15:map")).toBe("scope:15:map");
  expect(parentOf.get("25:publish/join")).toBe("subgraph:publish@16");
  expect(parentOf.get("26:join")).toBe("scope:15:map");
  expect(parentOf.get("0:status")).toBeNull();
});

test("two calls of one subgraph far apart get separate frames", () => {
  // Retag two runs of nodes as calls of one `deploy` subgraph, with other nodes in between.
  const calls = new Set([
    "16:publish/build",
    "17:publish/pack",
    "44:deploy",
    "45:sleep",
    "46:verify",
  ]);

  const retag = (id: string) =>
    calls.has(id) ? id.replace(/^(\d+):(?:publish\/)?/, "$1:deploy/") : id;

  const twice = graphRevisionViewSchema.parse({
    ...RELEASE,
    graph: {
      ...RELEASE.graph,
      nodes: RELEASE.graph.nodes.map((node) => ({ ...node, id: retag(node.id) })),
      edges: RELEASE.graph.edges.map((edge) => ({
        ...edge,
        from: retag(edge.from),
        to: retag(edge.to),
      })),
    },
  });

  const subgraphs = graphGroups(graphModel(twice.graph, null)).groups.filter(
    (group) => group.kind === "subgraph",
  );

  expect(subgraphs.map((group) => group.id)).toEqual([
    "subgraph:deploy@16",
    "subgraph:publish@18",
    "subgraph:deploy@44",
  ]);
});

test("layout runs left to right, keeps arms beside their control and the map's continuation after its body", () => {
  const x = (model: ReturnType<typeof graphModel>) => {
    const boxes = layoutGraph(model).nodes;

    return (id: string) => boxes.get(id)?.x ?? Number.NaN;
  };

  const review = x(graphModel(REVIEW.graph, null));
  expect(review("0:changes")).toBeLessThan(review("1:branch"));
  expect(review("1:branch")).toBeLessThan(review("10:join"));
  // The one-node yes arm starts beside the branch, not next to the merge.
  expect(review("2:log")).toBeLessThan(review("5:prompt"));

  const release = x(graphModel(RELEASE.graph, null));
  expect(release("26:join")).toBeLessThan(release("27:join"));
  expect(release("16:publish/build")).toBeLessThan(release("28:notes"));
});

test("the first view frames the run where it is: inner work in flight, else failures, else the entry", () => {
  const scoped = (nodeId: string, status: "succeeded" | "failed" | "running") => ({
    ...record(nodeId, status),
    key: { runId: "run-1", nodeId, scope: [] },
  });

  const parse = (nodeRuns: ReturnType<typeof scoped>[]) =>
    graphModel(RELEASE.graph, {
      status: "running",
      nodeRuns: nodeRuns.map((entry) => nodeRunViewSchema.parse(entry)),
    });

  const live = parse([scoped("15:map", "running"), scoped("16:publish/build", "running")]);
  expect(focusNodes(live, RELEASE.graph.entry)).toEqual(["16:publish/build"]);

  const control = parse([scoped("7:parallel", "running")]);
  expect(focusNodes(control, RELEASE.graph.entry)).toEqual(["7:parallel"]);

  const failed = parse([scoped("0:status", "succeeded"), scoped("1:plan", "failed")]);
  expect(focusNodes(failed, RELEASE.graph.entry)).toEqual(["1:plan"]);

  expect(focusNodes(graphModel(RELEASE.graph, null), RELEASE.graph.entry)).toEqual(["0:status"]);
});
