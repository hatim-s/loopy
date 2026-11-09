import { expect, test } from "bun:test";
import { Schema } from "effect";
import * as core from "../src";
import { type DiagnosticCode, executionKeyString, type Graph, validateGraph } from "../src";
import { decode } from "./fixtures/decode";
import { approveDemoGraph, mapGraph } from "./fixtures/graphs";

test("approve-demo is the canonical JSON graph for the builder", () => {
  expect(decode(core.graphSchema)(approveDemoGraph)).toEqual(approveDemoGraph);
  expect(decode(core.graphSchema)(JSON.parse(JSON.stringify(approveDemoGraph)))).toEqual(
    approveDemoGraph,
  );
  expect(validateGraph(approveDemoGraph)).toEqual([]);
});

test("execution timeouts are whole positive milliseconds from graph validation onward", () => {
  const nodes = approveDemoGraph.nodes;
  const command = nodes.find((node) => node.kind === "command");
  const code = nodes.find((node) => node.kind === "code");

  if (!command || !code) {
    throw new Error("approve-demo must keep a code node and a command node.");
  }

  const withTimeout = (timeout: core.Duration) => [
    { ...code, timeout },
    { ...command, options: { ...command.options, timeout } },
  ];

  for (const timeout of [0, "0s", 1.5, "0.0001s"] as const) {
    for (const node of withTimeout(timeout)) {
      expect(() => decode(core.nodeSchema)(node)).toThrow("at least 1 ms in whole milliseconds");
    }
  }

  for (const timeout of [1500, "1.5s"] as const) {
    expect(withTimeout(timeout).map((node) => decode(core.nodeSchema)(node))).toEqual(
      withTimeout(timeout),
    );
  }

  const spec = { kind: "code" as const, bundleHash: "a".repeat(64), input: {}, timeoutMs: 1500 };
  expect(decode(core.executionSpecSchema)(spec)).toEqual(spec);

  for (const timeoutMs of [0, 1.5]) {
    expect(() => decode(core.executionSpecSchema)({ ...spec, timeoutMs })).toThrow();
  }
});

function broken(
  code: DiagnosticCode,
  change: (graph: Graph) => Graph,
  related: DiagnosticCode[] = [],
) {
  test(`graph validation reports ${code}`, () => {
    expect(
      validateGraph(change(structuredClone(approveDemoGraph))).map((error) => error.code),
    ).toEqual([code, ...related]);
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
    {
      from: graph.entry,
      to: decode(core.nodeIdSchema)("missing"),
      kind: "next",
    },
  ],
}));

broken("missing_entry", (graph) => ({
  ...graph,
  entry: decode(core.nodeIdSchema)("missing"),
}));

broken("unresolved_ref", (graph) => ({
  ...graph,
  outputs: { ref: decode(core.refIdSchema)("missing"), path: [] },
}));

broken("out_of_scope_ref", (graph) => ({
  ...graph,
  outputs: { ref: decode(core.refIdSchema)("5:apply"), path: [] },
}));

broken("predicate_type", (graph) => ({
  ...graph,
  nodes: graph.nodes.map((node) =>
    node.kind === "branch"
      ? {
          ...node,
          predicate: {
            op: "eq",
            left: {
              ref: decode(core.refIdSchema)("2:approve"),
              path: ["approved"],
            },
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
            value: {
              ref: decode(core.refIdSchema)("2:approve"),
              path: [],
              size: true,
            },
          },
        }
      : node,
  ),
}));

broken(
  "missing_arm",
  (graph) => ({
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.kind === "branch"
        ? {
            ...node,
            arms: { ...node.arms, no: decode(core.nodeIdSchema)("missing") },
          }
        : node,
    ),
  }),
  ["invalid_scope"],
);

broken("invalid_scope", (graph) => ({
  ...graph,
  nodes: graph.nodes.map((node) => (node.id === "7:fail" ? { ...node, scope: null } : node)),
}));

test("graph validation reports cycle", () => {
  const graph = structuredClone(approveDemoGraph);
  graph.edges.push({
    from: decode(core.nodeIdSchema)("8:join"),
    to: graph.entry,
    kind: "next",
  });

  // A back edge is also a second continuation for its source.
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["invalid_scope", "cycle"]);
});

test("execution identity escapes delimiters and distinguishes runs and iteration paths", () => {
  const nodeId = decode(core.nodeIdSchema)("a/b");

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
    { runId: "run", nodeId: decode(core.nodeIdSchema)('a/b"/[1]'), scope: [] },
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
    expect(
      Schema.decodeUnknownExit(core.valueSchema)(value, { onExcessProperty: "error" })._tag ===
        "Success",
    ).toBe(false);
  }

  expect(decode(core.valueSchema)({ nested: { ref: "draft", path: [] } })).toEqual({
    nested: { ref: "draft", path: [] },
  });
});

test("map bindings stay inside the body and only scope joins can iterate", () => {
  expect(validateGraph(mapGraph)).toEqual([]);
  expect(
    validateGraph({
      ...mapGraph,
      outputs: { ref: decode(core.refIdSchema)("item"), path: [] },
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

  expect(validateGraph(badCycle).map((error) => error.code)).toEqual(["invalid_scope", "cycle"]);
});

test("parallel siblings cannot consume one another's results", () => {
  const graph = decode(core.graphSchema)({
    version: 1,
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
    name: "parallel",
    input: {},
    entry: "parallel",
    outputs: null,
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
  const graph = decode(core.graphSchema)({
    version: 1,
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
    name: "rescue",
    input: {},
    entry: "rescue",
    outputs: null,
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
      ? {
          ...node,
          message: {
            ref: decode(core.refIdSchema)("error"),
            path: ["message"],
          },
        }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["out_of_scope_ref"]);
});

test("scope bindings cannot shadow node outputs, input, or one another", () => {
  const withoutIndex = mapGraph.nodes.map((node) =>
    node.kind === "format" ? { ...node, values: { value: node.values.value ?? "" } } : node,
  );

  const graph = {
    ...mapGraph,
    nodes: withoutIndex.map((node) => (node.kind === "map" ? { ...node, index: node.item } : node)),
  };

  expect(validateGraph(graph).map((error) => error.code)).toEqual(["duplicate_ref"]);

  const shadow = {
    ...mapGraph,
    nodes: withoutIndex.map((node) =>
      node.kind === "map" ? { ...node, index: decode(core.refIdSchema)("input") } : node,
    ),
  };

  expect(validateGraph(shadow).map((error) => error.code)).toEqual(["duplicate_ref"]);
});

test("a map body cannot consume its enclosing map output", () => {
  const graph = {
    ...mapGraph,
    nodes: mapGraph.nodes.map((node) =>
      node.kind === "join"
        ? {
            ...node,
            result: {
              kind: "value" as const,
              value: { ref: decode(core.refIdSchema)("map"), path: [] },
            },
          }
        : node,
    ),
  };

  expect(validateGraph(graph).map((error) => error.code)).toEqual(["out_of_scope_ref"]);
});

test("disconnected nodes are diagnosed", () => {
  const graph = {
    ...approveDemoGraph,
    nodes: [
      ...approveDemoGraph.nodes,
      decode(core.nodeSchema)({
        id: "orphan",
        kind: "uuid",
        label: null,
        scope: null,
      }),
    ],
  };

  expect(
    validateGraph(graph)
      .filter((error) => error.code === "invalid_scope")
      .map((error) => error.node),
  ).toEqual([decode(core.nodeIdSchema)("orphan")]);
});

test("a node with next edges to two different targets is diagnosed", () => {
  const sibling = decode(core.nodeSchema)({
    id: "sibling",
    kind: "uuid",
    label: null,
    scope: null,
  });

  const graph = {
    ...approveDemoGraph,
    nodes: [...approveDemoGraph.nodes, sibling],
    edges: [
      ...approveDemoGraph.edges,
      { from: approveDemoGraph.entry, to: sibling.id, kind: "next" as const },
    ],
  };

  expect(validateGraph(graph)).toEqual([
    {
      code: "invalid_scope",
      node: approveDemoGraph.entry,
      message: "A node must continue to exactly one next node.",
    },
  ]);
});

test("a second root with an edge into the graph is diagnosed", () => {
  const root = decode(core.nodeSchema)({
    id: "root",
    kind: "uuid",
    label: null,
    scope: null,
  });

  const graph = {
    ...approveDemoGraph,
    nodes: [...approveDemoGraph.nodes, root],
    edges: [
      ...approveDemoGraph.edges,
      { from: root.id, to: approveDemoGraph.entry, kind: "next" as const },
    ],
  };

  expect(validateGraph(graph).map((error) => error.code)).toContain("invalid_scope");
});

for (const target of ["5:apply", "6:join"]) {
  test(`outside edges cannot enter body node ${target}`, () => {
    const graph = {
      ...approveDemoGraph,
      edges: [
        ...approveDemoGraph.edges,
        {
          from: approveDemoGraph.entry,
          to: decode(core.nodeIdSchema)(target),
          kind: "next" as const,
        },
      ],
    };

    expect(validateGraph(graph).map((error) => error.code)).toContain("invalid_scope");
  });
}

test("sibling arm edges cannot grant reference visibility", () => {
  const graph = {
    ...approveDemoGraph,
    nodes: approveDemoGraph.nodes.map((node) =>
      node.kind === "fail"
        ? {
            ...node,
            message: { ref: decode(core.refIdSchema)("4:format"), path: [] },
          }
        : node,
    ),
    edges: [
      ...approveDemoGraph.edges,
      {
        from: decode(core.nodeIdSchema)("4:format"),
        to: decode(core.nodeIdSchema)("7:fail"),
        kind: "next" as const,
      },
    ],
  };

  const codes = validateGraph(graph).map((error) => error.code);
  expect(codes).toContain("invalid_scope");
  expect(codes).toContain("out_of_scope_ref");
});
