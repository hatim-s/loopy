import { expect, expectTypeOf, test } from "bun:test";
import * as contract from "../src/contract/index.js";
import type * as core from "../src/core/index.js";
import {
  type DiagnosticCode,
  executionKeyString,
  type Graph,
  validateGraph,
} from "../src/core/index.js";
import { approveDemoGraph } from "./fixtures/graphs.js";

type Flatten<T> = T extends unknown ? { [K in keyof T]: T[K] } : never;

test("graph schemas exactly match the portable model", () => {
  expectTypeOf<contract.Graph>().toEqualTypeOf<core.Graph>();
  expectTypeOf<contract.Node>().toEqualTypeOf<Flatten<core.Node>>();
  expectTypeOf<contract.Edge>().toEqualTypeOf<Flatten<core.Edge>>();
  expectTypeOf<contract.Value>().toEqualTypeOf<core.Value>();
  expectTypeOf<contract.Ref>().toEqualTypeOf<core.Ref>();
  expectTypeOf<contract.OutputSchema>().toEqualTypeOf<core.OutputSchema>();
  expectTypeOf<contract.Diagnostic>().toEqualTypeOf<core.Diagnostic>();
  expectTypeOf<contract.ExecutionKey>().toEqualTypeOf<core.ExecutionKey>();
  expectTypeOf<contract.NodeRun>().toEqualTypeOf<Flatten<core.NodeRun>>();
  expectTypeOf<contract.NodeRunView>().toEqualTypeOf<Flatten<core.NodeRun>>();
  expectTypeOf<contract.GraphView>().toEqualTypeOf<
    Flatten<
      Omit<core.Graph, "nodes"> & {
        nodes: Flatten<
          | Exclude<Flatten<core.Node>, { kind: "code" | "command" }>
          | (Omit<Extract<core.Node, { kind: "code" }>, "module"> & { module: { name: string } })
          | (Omit<Extract<core.Node, { kind: "command" }>, "parse"> & {
              parse: Record<string, never> | null;
            })
        >[];
      }
    >
  >();
  expectTypeOf<ReturnType<typeof contract.predicateSchema.parse>>().toEqualTypeOf<core.Predicate>();
});

test("approve-demo is the canonical JSON graph for the builder", () => {
  expect(contract.graphSchema.parse(approveDemoGraph)).toEqual(approveDemoGraph);
  expect(contract.graphSchema.parse(JSON.parse(JSON.stringify(approveDemoGraph)))).toEqual(
    approveDemoGraph,
  );
  expect(validateGraph(approveDemoGraph)).toEqual([]);
});

function broken(code: DiagnosticCode, change: (graph: Graph) => Graph) {
  test(`graph validation reports only ${code}`, () => {
    expect(
      validateGraph(change(structuredClone(approveDemoGraph))).map((error) => error.code),
    ).toEqual([code]);
  });
}

broken("duplicate_node", (graph) => ({
  ...graph,
  nodes: [...graph.nodes, ...graph.nodes.slice(0, 1)],
}));

broken("missing_endpoint", (graph) => ({
  ...graph,
  edges: [
    ...graph.edges,
    { from: graph.entry, to: contract.nodeIdSchema.parse("missing"), kind: "next" },
  ],
}));

broken("missing_entry", (graph) => ({ ...graph, entry: contract.nodeIdSchema.parse("missing") }));

broken("unresolved_ref", (graph) => ({
  ...graph,
  outputs: { ref: contract.refIdSchema.parse("missing"), path: [] },
}));

broken("out_of_scope_ref", (graph) => ({
  ...graph,
  outputs: { ref: contract.refIdSchema.parse("5:apply"), path: [] },
}));

broken("predicate_type", (graph) => ({
  ...graph,
  nodes: graph.nodes.map((node) =>
    node.kind === "branch"
      ? {
          ...node,
          predicate: {
            op: "eq",
            left: { ref: contract.refIdSchema.parse("2:approve"), path: ["approved"] },
            right: "true",
          },
        }
      : node,
  ),
}));

broken("invalid_size", (graph) => ({
  ...graph,
  nodes: graph.nodes.map((node) =>
    node.kind === "branch"
      ? {
          ...node,
          predicate: {
            op: "exists",
            value: { ref: contract.refIdSchema.parse("2:approve"), path: [], size: true },
          },
        }
      : node,
  ),
}));

broken("missing_arm", (graph) => ({
  ...graph,
  nodes: graph.nodes.map((node) =>
    node.kind === "branch"
      ? { ...node, arms: { ...node.arms, no: contract.nodeIdSchema.parse("missing") } }
      : node,
  ),
}));

broken("invalid_scope", (graph) => ({
  ...graph,
  nodes: graph.nodes.map((node) => (node.id === "7:fail" ? { ...node, scope: null } : node)),
}));

broken("cycle", (graph) => ({
  ...graph,
  edges: [
    ...graph.edges,
    { from: contract.nodeIdSchema.parse("8:join"), to: graph.entry, kind: "next" },
  ],
}));

test("execution identity escapes delimiters and distinguishes runs and iteration paths", () => {
  const nodeId = contract.nodeIdSchema.parse("a/b");

  const keys: core.ExecutionKey[] = [
    { runId: "run", nodeId, scope: [] },
    { runId: "run/other", nodeId, scope: [] },
    { runId: "run", nodeId, scope: [{ nodeId, index: 1 }] },
    { runId: "run", nodeId, scope: [{ nodeId, index: 11 }] },
    {
      runId: "run",
      nodeId,
      scope: [
        { nodeId, index: 1 },
        { nodeId, index: 1 },
      ],
    },
    { runId: "run", nodeId: contract.nodeIdSchema.parse('a/b"/[1]'), scope: [] },
  ];

  expect(new Set(keys.map(executionKeyString)).size).toBe(keys.length);
});

test("strict value boundaries reject malformed refs instead of accepting them as literals", () => {
  for (const value of [
    { ref: "draft", path: [], extra: true },
    { ref: "draft", path: [1] },
    { ref: "draft" },
    { ref: 1, path: [] },
    { nested: { ref: "draft", path: [], size: true } },
  ]) {
    expect(contract.valueSchema.safeParse(value).success).toBe(false);
  }

  expect(contract.valueSchema.parse({ nested: { ref: "draft", path: [] } })).toEqual({
    nested: { ref: "draft", path: [] },
  });
});

test("declared ref fields resolve and predicate size has a numeric comparison type", () => {
  const graph = structuredClone(approveDemoGraph);
  graph.nodes = graph.nodes.map((node) =>
    node.kind === "branch"
      ? {
          ...node,
          predicate: {
            op: "gt",
            left: { ref: contract.refIdSchema.parse("input"), path: ["subject"], size: true },
            right: 0,
          },
        }
      : node,
  );
  expect(validateGraph(graph)).toEqual([]);
  graph.nodes = graph.nodes.map((node) =>
    node.kind === "branch"
      ? {
          ...node,
          predicate: {
            op: "eq",
            left: { ref: contract.refIdSchema.parse("0:draft"), path: ["missing"] },
            right: 0,
          },
        }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);
});

const mapGraph = contract.graphSchema.parse({
  version: 1,
  name: "map",
  input: { items: "json" },
  entry: "map",
  outputs: { ref: "map", path: [] },
  warnings: [],
  nodes: [
    {
      id: "map",
      kind: "map",
      scope: null,
      label: null,
      over: { ref: "input", path: ["items"] },
      body: "body",
      item: "item",
      index: "index",
      concurrency: 4,
      onError: "collect",
    },
    {
      id: "body",
      kind: "format",
      scope: "map",
      label: null,
      template: "{i}:{value}",
      values: { i: { ref: "index", path: [] }, value: { ref: "item", path: [] } },
    },
    { id: "end", kind: "join", scope: "map", label: null, result: { ref: "body", path: [] } },
  ],
  edges: [
    { from: "map", to: "body", kind: "each" },
    { from: "body", to: "end", kind: "next" },
    { from: "end", to: "map", kind: "join" },
  ],
});

test("map bindings stay inside the body and only scope joins can iterate", () => {
  expect(validateGraph(mapGraph)).toEqual([]);
  expect(
    validateGraph({
      ...mapGraph,
      outputs: { ref: contract.refIdSchema.parse("item"), path: [] },
    }).map((error) => error.code),
  ).toEqual(["out_of_scope_ref"]);

  const badScope = {
    ...mapGraph,
    nodes: mapGraph.nodes.map((node) => (node.id === "body" ? { ...node, scope: null } : node)),
  };

  expect(validateGraph(badScope).some((error) => error.code === "invalid_scope")).toBe(true);

  const badCycle = {
    ...mapGraph,
    edges: mapGraph.edges.map((edge) =>
      edge.to === "map" ? { ...edge, kind: "next" as const } : edge,
    ),
  };

  expect(validateGraph(badCycle).map((error) => error.code)).toEqual(["cycle"]);
});

test("parallel siblings cannot consume one another's results", () => {
  const graph = contract.graphSchema.parse({
    version: 1,
    name: "parallel",
    input: {},
    entry: "parallel",
    outputs: null,
    warnings: [],
    nodes: [
      { id: "parallel", kind: "parallel", scope: null, label: null, branches: { a: "a", b: "b" } },
      { id: "a", kind: "uuid", scope: "parallel", label: null },
      {
        id: "b",
        kind: "log",
        scope: "parallel",
        label: null,
        message: { ref: "a", path: [] },
        data: null,
      },
    ],
    edges: [],
  });

  expect(validateGraph(graph).map((error) => error.code)).toEqual(["out_of_scope_ref"]);
});

test("rescue error binding is visible only to the handler", () => {
  const graph = contract.graphSchema.parse({
    version: 1,
    name: "rescue",
    input: {},
    entry: "rescue",
    outputs: null,
    warnings: [],
    nodes: [
      {
        id: "rescue",
        kind: "rescue",
        scope: null,
        label: null,
        body: "body",
        handler: "handler",
        error: "error",
      },
      { id: "body", kind: "fail", scope: "rescue", label: null, message: "failed" },
      {
        id: "handler",
        kind: "log",
        scope: "rescue",
        label: null,
        message: { ref: "error", path: ["message"] },
        data: null,
      },
    ],
    edges: [],
  });

  expect(validateGraph(graph)).toEqual([]);
  graph.nodes = graph.nodes.map((node) =>
    node.kind === "fail"
      ? { ...node, message: { ref: contract.refIdSchema.parse("error"), path: ["message"] } }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["out_of_scope_ref"]);
});

test("graph wire views reject paths and hashes, including command parser hashes", () => {
  const nodes = approveDemoGraph.nodes.map((node) => {
    if (node.kind === "code") {
      return { ...node, module: { name: "draft.ts" } };
    }

    if (node.kind === "command") {
      return { ...node, parse: node.parse === null ? null : {} };
    }

    return node;
  });

  const view = { ...approveDemoGraph, nodes };
  expect(contract.graphViewSchema.parse(view)).toEqual(view);
  expect(contract.graphViewSchema.safeParse(approveDemoGraph).success).toBe(false);
  expect(
    contract.graphViewSchema.safeParse({
      ...view,
      nodes: nodes.map((node) =>
        node.kind === "command" ? { ...node, parse: { bundleHash: "secret" } } : node,
      ),
    }).success,
  ).toBe(false);
});

test("every node run status round-trips without optional state fields", () => {
  const base = {
    key: { runId: "run", nodeId: contract.nodeIdSchema.parse("0:draft"), scope: [] },
    attempt: 1,
    maxAttempts: 3,
    startedAt: "2026-10-18T00:00:00.000Z",
  };

  const states = [
    { status: "running" },
    { status: "succeeded", output: null, endedAt: base.startedAt },
    { status: "failed", error: "failed", endedAt: base.startedAt },
    { status: "retrying", error: "failed", nextRetryAt: base.startedAt, endedAt: base.startedAt },
    { status: "waiting", wakeAt: null },
    { status: "sleeping", wakeAt: base.startedAt },
    { status: "cancelled", endedAt: base.startedAt },
  ] as const;

  for (const state of states) {
    const record = { ...base, ...state };
    expect(contract.nodeRunSchema.parse(record)).toEqual(record);
    expect(
      contract.serverEventSchema.parse({
        entity: "node",
        kind: state.status,
        sequence: 1,
        at: base.startedAt,
        txn: "txn",
        runId: "run",
        record,
      }).record,
    ).toEqual(record);
  }

  expect(contract.nodeRunSchema.safeParse({ ...base, status: "waiting" }).success).toBe(false);
  expect(
    contract.nodeRunSchema.safeParse({ ...base, status: "running", output: null }).success,
  ).toBe(false);
});

test("scope bindings cannot shadow node outputs, input, or one another", () => {
  const withoutIndex = mapGraph.nodes.map((node) =>
    node.kind === "format" ? { ...node, values: { value: node.values.value ?? null } } : node,
  );

  const graph = {
    ...mapGraph,
    nodes: withoutIndex.map((node) => (node.kind === "map" ? { ...node, index: node.item } : node)),
  };

  expect(validateGraph(graph).map((error) => error.code)).toEqual(["duplicate_ref"]);

  const shadow = {
    ...mapGraph,
    nodes: withoutIndex.map((node) =>
      node.kind === "map" ? { ...node, index: contract.refIdSchema.parse("input") } : node,
    ),
  };

  expect(validateGraph(shadow).map((error) => error.code)).toEqual(["duplicate_ref"]);
});
