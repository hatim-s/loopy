import { expect, test } from "bun:test";
import * as contract from "@loopy/contract";
import type * as core from "@loopy/core";
import {
  type DiagnosticCode,
  ERROR_FIELDS,
  executionKeyString,
  FIELD_TYPES,
  type Graph,
  graphTypeResolver,
  validateGraph,
} from "@loopy/core";
import { Schema } from "effect";
import { approveDemoGraph } from "./fixtures/graphs";

test("approve-demo is the canonical JSON graph for the builder", () => {
  expect(contract.decodeBoundary(contract.graphSchema)(approveDemoGraph)).toEqual(approveDemoGraph);
  expect(
    contract.decodeBoundary(contract.graphSchema)(JSON.parse(JSON.stringify(approveDemoGraph))),
  ).toEqual(approveDemoGraph);
  expect(validateGraph(approveDemoGraph)).toEqual([]);
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
      to: contract.decodeBoundary(contract.nodeIdSchema)("missing"),
      kind: "next",
    },
  ],
}));

broken("missing_entry", (graph) => ({
  ...graph,
  entry: contract.decodeBoundary(contract.nodeIdSchema)("missing"),
}));

broken("unresolved_ref", (graph) => ({
  ...graph,
  outputs: { ref: contract.decodeBoundary(contract.refIdSchema)("missing"), path: [] },
}));

broken("out_of_scope_ref", (graph) => ({
  ...graph,
  outputs: { ref: contract.decodeBoundary(contract.refIdSchema)("5:apply"), path: [] },
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
              ref: contract.decodeBoundary(contract.refIdSchema)("2:approve"),
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
              ref: contract.decodeBoundary(contract.refIdSchema)("2:approve"),
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
            arms: { ...node.arms, no: contract.decodeBoundary(contract.nodeIdSchema)("missing") },
          }
        : node,
    ),
  }),
  ["invalid_scope", "invalid_scope"],
);

broken("invalid_scope", (graph) => ({
  ...graph,
  nodes: graph.nodes.map((node) => (node.id === "7:fail" ? { ...node, scope: null } : node)),
}));

broken("cycle", (graph) => ({
  ...graph,
  edges: [
    ...graph.edges,
    {
      from: contract.decodeBoundary(contract.nodeIdSchema)("8:join"),
      to: graph.entry,
      kind: "next",
    },
  ],
}));

test("execution identity escapes delimiters and distinguishes runs and iteration paths", () => {
  const nodeId = contract.decodeBoundary(contract.nodeIdSchema)("a/b");

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
    { runId: "run", nodeId: contract.decodeBoundary(contract.nodeIdSchema)('a/b"/[1]'), scope: [] },
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
      Schema.decodeUnknownExit(contract.valueSchema)(value, { onExcessProperty: "error" })._tag ===
        "Success",
    ).toBe(false);
  }

  expect(
    contract.decodeBoundary(contract.valueSchema)({ nested: { ref: "draft", path: [] } }),
  ).toEqual({
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
            left: {
              ref: contract.decodeBoundary(contract.refIdSchema)("input"),
              path: ["subject"],
              size: true,
            },
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
            left: {
              ref: contract.decodeBoundary(contract.refIdSchema)("0:draft"),
              path: ["missing"],
            },
            right: 0,
          },
        }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);
});

const mapGraph = contract.decodeBoundary(contract.graphSchema)({
  version: 1,
  meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
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
      values: { i: { ref: "index", path: [] }, value: "item" },
    },
    {
      id: "end",
      kind: "join",
      scope: "map",
      label: null,
      result: {
        kind: "value" as const,
        value: { value: { ref: "item", path: [] }, formatted: { ref: "body", path: [] } },
      },
    },
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
      outputs: { ref: contract.decodeBoundary(contract.refIdSchema)("item"), path: [] },
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
  const graph = contract.decodeBoundary(contract.graphSchema)({
    version: 1,
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
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
  const graph = contract.decodeBoundary(contract.graphSchema)({
    version: 1,
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
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
      ? {
          ...node,
          message: {
            ref: contract.decodeBoundary(contract.refIdSchema)("error"),
            path: ["message"],
          },
        }
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
      return { ...node, parse: node.parse === null ? null : { input: node.parse.input } };
    }

    return node;
  });

  const view = { ...approveDemoGraph, nodes, warnings: [] };
  expect(contract.decodeBoundary(contract.graphViewSchema)(view)).toEqual(view);
  expect(
    Schema.decodeUnknownExit(contract.graphViewSchema)(approveDemoGraph, {
      onExcessProperty: "error",
    })._tag === "Success",
  ).toBe(false);
  expect(
    Schema.decodeUnknownExit(contract.graphViewSchema)(
      {
        ...view,
        nodes: nodes.map((node) =>
          node.kind === "command" ? { ...node, parse: { bundleHash: "secret" } } : node,
        ),
      },
      { onExcessProperty: "error" },
    )._tag === "Success",
  ).toBe(false);
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
      node.kind === "map"
        ? { ...node, index: contract.decodeBoundary(contract.refIdSchema)("input") }
        : node,
    ),
  };

  expect(validateGraph(shadow).map((error) => error.code)).toEqual(["duplicate_ref"]);
});

function withPredicate(predicate: core.Predicate): Graph {
  return {
    ...approveDemoGraph,
    input: {
      "subject?": "string",
      data: "json",
      text: "string",
    },
    nodes: approveDemoGraph.nodes.map((node) =>
      node.kind === "branch" ? { ...node, predicate } : node,
    ),
  };
}

const jsonRef = { ref: contract.decodeBoundary(contract.refIdSchema)("input"), path: ["data"] };

for (const op of ["lt", "lte", "gt", "gte"] as const) {
  test(`${op} rejects JSON and non-orderable declared types`, () => {
    for (const [left, right] of [
      [jsonRef, 1],
      [1, jsonRef],
      [true, false],
      ["a", 1],
    ]) {
      const predicate = contract.decodeBoundary(contract.predicateSchema)({ op, left, right });
      expect(validateGraph(withPredicate(predicate)).map((error) => error.code)).toContain(
        "predicate_type",
      );
    }

    expect(validateGraph(withPredicate({ op, left: "a", right: "b" }))).toEqual([]);
    expect(validateGraph(withPredicate({ op, left: 1, right: 2 }))).toEqual([]);
  });
}

test("size requires declared string or array and in requires matching array elements", () => {
  expect(
    validateGraph(withPredicate({ op: "gt", left: { ...jsonRef, size: true }, right: 0 })).map(
      (error) => error.code,
    ),
  ).toEqual(["invalid_size"]);

  for (const [left, right] of [
    [1, jsonRef],
    [jsonRef, [1]],
    [1, ["a"]],
    [1, "text"],
  ]) {
    expect(
      validateGraph(
        withPredicate(contract.decodeBoundary(contract.predicateSchema)({ op: "in", left, right })),
      ).map((error) => error.code),
    ).toEqual(["predicate_type"]);
  }

  expect(validateGraph(withPredicate({ op: "in", left: 1, right: [1, 2] }))).toEqual([]);
});

for (const op of ["eq", "ne", "exists", "isNull"] as const) {
  test(`${op} accepts declared JSON`, () => {
    const predicate: core.Predicate =
      op === "eq" || op === "ne" ? { op, left: jsonRef, right: jsonRef } : { op, value: jsonRef };

    expect(validateGraph(withPredicate(predicate))).toEqual([]);
  });
}

test("a map body cannot consume its enclosing map output", () => {
  const graph = {
    ...mapGraph,
    nodes: mapGraph.nodes.map((node) =>
      node.kind === "join"
        ? {
            ...node,
            result: {
              kind: "value" as const,
              value: { ref: contract.decodeBoundary(contract.refIdSchema)("map"), path: [] },
            },
          }
        : node,
    ),
  };

  expect(validateGraph(graph).map((error) => error.code)).toEqual(["out_of_scope_ref"]);
});

test("format accepts scalar literals and declared scalar refs only", () => {
  for (const path of [[], ["data"]]) {
    const graph = {
      ...approveDemoGraph,
      input: { data: "json" as const },
      nodes: approveDemoGraph.nodes.map((node) =>
        node.kind === "format"
          ? {
              ...node,
              values: {
                value: { ref: contract.decodeBoundary(contract.refIdSchema)("input"), path },
              },
            }
          : node,
      ),
    };

    expect(validateGraph(graph).map((error) => error.code)).toContain("format_type");
  }

  for (const value of [null, [], {}]) {
    const format = approveDemoGraph.nodes.find((node) => node.kind === "format");
    expect(
      Schema.decodeUnknownExit(contract.nodeSchema)(
        { ...format, values: { value } },
        { onExcessProperty: "error" },
      )._tag === "Success",
    ).toBe(false);
  }
});

test("graph warning views project node labels without source module paths", () => {
  const graph = {
    ...approveDemoGraph,
    warnings: [
      {
        code: "predicate_type" as const,
        message: "warning",
        node: approveDemoGraph.entry,
        source: { module: "/private/author.ts", line: 1, column: 1 },
      },
    ],
  };

  const view = contract.graphView(graph);
  expect(view.warnings).toEqual([
    { code: "predicate_type", message: "warning", nodeId: graph.entry, label: "draft" },
  ]);
  expect(contract.decodeBoundary(contract.graphViewSchema)(view)).toEqual(view);
  expect(JSON.stringify(view)).not.toContain("/private/author.ts");
  expect(
    Schema.decodeUnknownExit(contract.graphViewSchema)(
      { ...view, warnings: graph.warnings },
      { onExcessProperty: "error" },
    )._tag === "Success",
  ).toBe(false);
});

test("predicate wire schema parses the complete vocabulary and rejects unknown ops", () => {
  for (const op of ["eq", "ne", "lt", "lte", "gt", "gte", "in"] as const) {
    const predicate = { op, left: 1, right: 1 };
    expect(JSON.stringify(contract.decodeBoundary(contract.predicateSchema)(predicate))).toBe(
      JSON.stringify(predicate),
    );
  }

  const eq = { op: "eq", left: 1, right: 1 } as const;

  for (const predicate of [
    { op: "exists", value: 1 },
    { op: "isNull", value: null },
    { op: "and", predicates: [eq] },
    { op: "or", predicates: [eq] },
    { op: "not", predicate: eq },
    { op: "gt", left: { ref: "input", path: ["text"], size: true }, right: 0 },
  ]) {
    expect(JSON.stringify(contract.decodeBoundary(contract.predicateSchema)(predicate))).toBe(
      JSON.stringify(predicate),
    );
  }

  expect(
    Schema.decodeUnknownExit(contract.predicateSchema)(
      { op: "unknown" },
      { onExcessProperty: "error" },
    )._tag === "Success",
  ).toBe(false);
});

test("disconnected nodes are diagnosed", () => {
  const graph = {
    ...approveDemoGraph,
    nodes: [
      ...approveDemoGraph.nodes,
      contract.decodeBoundary(contract.nodeSchema)({
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
  ).toEqual([contract.decodeBoundary(contract.nodeIdSchema)("orphan")]);
});

test("a second root with an edge into the graph is diagnosed", () => {
  const root = contract.decodeBoundary(contract.nodeSchema)({
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
          to: contract.decodeBoundary(contract.nodeIdSchema)(target),
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
            message: { ref: contract.decodeBoundary(contract.refIdSchema)("4:format"), path: [] },
          }
        : node,
    ),
    edges: [
      ...approveDemoGraph.edges,
      {
        from: contract.decodeBoundary(contract.nodeIdSchema)("4:format"),
        to: contract.decodeBoundary(contract.nodeIdSchema)("7:fail"),
        kind: "next" as const,
      },
    ],
  };

  const codes = validateGraph(graph).map((error) => error.code);
  expect(codes).toContain("invalid_scope");
  expect(codes).toContain("out_of_scope_ref");
});

test("array refs use the declared map result type for size and membership", () => {
  const done = contract.decodeBoundary(contract.nodeIdSchema)("done");
  const mapRef = { ref: contract.decodeBoundary(contract.refIdSchema)("map"), path: [] };

  const graph: Graph = {
    ...mapGraph,
    nodes: [
      ...mapGraph.nodes.map((node) =>
        node.kind === "map"
          ? { ...node, onError: "fail" as const }
          : node.kind === "join"
            ? {
                ...node,
                result: {
                  kind: "value" as const,
                  value: { ref: contract.decodeBoundary(contract.refIdSchema)("body"), path: [] },
                },
              }
            : node,
      ),
      {
        id: done,
        kind: "branch",
        scope: null,
        label: null,
        arms: {
          yes: contract.decodeBoundary(contract.nodeIdSchema)("yes"),
          no: contract.decodeBoundary(contract.nodeIdSchema)("no"),
        },
        predicate: { op: "in", left: "value", right: mapRef },
      },
      {
        id: contract.decodeBoundary(contract.nodeIdSchema)("yes"),
        kind: "uuid",
        scope: done,
        label: null,
      },
      {
        id: contract.decodeBoundary(contract.nodeIdSchema)("no"),
        kind: "uuid",
        scope: done,
        label: null,
      },
    ],
    edges: [...mapGraph.edges, { from: mapGraph.entry, to: done, kind: "next" }],
  };

  expect(validateGraph(graph)).toEqual([]);

  for (const predicate of [
    { op: "in", left: 1, right: mapRef },
    { op: "gt", left: { ...mapRef, size: true }, right: 0 },
  ] satisfies core.Predicate[]) {
    const changed = {
      ...graph,
      nodes: graph.nodes.map((node) => (node.kind === "branch" ? { ...node, predicate } : node)),
    };

    expect(validateGraph(changed).map((error) => error.code)).toEqual(
      predicate.op === "in" ? ["predicate_type"] : [],
    );
  }
});

function numericBranchGraph(): Graph {
  return contract.decodeBoundary(contract.graphSchema)({
    version: 1,
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
    name: "derived-types",
    input: {},
    entry: "branch",
    outputs: null,
    warnings: [],
    nodes: [
      {
        id: "branch",
        kind: "branch",
        scope: null,
        label: null,
        predicate: { op: "eq", left: true, right: true },
        arms: { yes: "yes", no: "no" },
      },
      {
        id: "yes",
        kind: "join",
        scope: "branch",
        label: null,
        result: { kind: "value" as const, value: 1 },
      },
      {
        id: "no",
        kind: "join",
        scope: "branch",
        label: null,
        result: { kind: "value" as const, value: 2 },
      },
      {
        id: "result",
        kind: "join",
        scope: null,
        label: null,
        result: { kind: "value" as const, value: { ref: "branch", path: [] } },
      },
      {
        id: "check",
        kind: "branch",
        scope: null,
        label: null,
        predicate: { op: "gt", left: { ref: "branch", path: [] }, right: 0 },
        arms: { yes: "pass", no: "fail" },
      },
      { id: "pass", kind: "uuid", scope: "check", label: null },
      { id: "fail", kind: "uuid", scope: "check", label: null },
    ],
    edges: [
      { from: "branch", to: "yes", kind: "yes" },
      { from: "branch", to: "no", kind: "no" },
      { from: "yes", to: "result", kind: "join" },
      { from: "no", to: "result", kind: "join" },
      { from: "result", to: "check", kind: "next" },
    ],
  });
}

test("numeric branch results allow ordering and reject string equality", () => {
  const graph = numericBranchGraph();
  expect(validateGraph(graph)).toEqual([]);
  graph.nodes = graph.nodes.map((node) =>
    node.id === "check" && node.kind === "branch"
      ? {
          ...node,
          predicate: {
            op: "eq",
            left: { ref: contract.decodeBoundary(contract.refIdSchema)("branch"), path: [] },
            right: "wrong",
          },
        }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["predicate_type"]);
});

test("a branch with mismatched arm results rejects ordering", () => {
  const graph = numericBranchGraph();
  graph.nodes = graph.nodes.map((node) =>
    node.id === "no" && node.kind === "join"
      ? { ...node, result: { kind: "value" as const, value: "wrong" } }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["predicate_type"]);
});

test("switch results resolve through each arm's terminal join", () => {
  const graph = numericBranchGraph();
  graph.input = { choice: "string" };
  graph.nodes = graph.nodes.map((node) =>
    node.id === "branch"
      ? contract.decodeBoundary(contract.nodeSchema)({
          id: node.id,
          kind: "switch",
          scope: null,
          label: null,
          on: { ref: "input", path: ["choice"] },
          cases: { yes: "yes" },
          default: "no",
        })
      : node,
  );
  graph.edges = graph.edges.map((edge) =>
    edge.from === "branch"
      ? { ...edge, kind: "case", label: edge.to === "yes" ? "yes" : "default" }
      : edge,
  );
  expect(validateGraph(graph)).toEqual([]);
  graph.nodes = graph.nodes.map((node) =>
    node.id === "no" && node.kind === "join"
      ? { ...node, result: { kind: "value" as const, value: "wrong" } }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["predicate_type"]);
});

test("format accepts a scalar join result", () => {
  const graph = contract.decodeBoundary(contract.graphSchema)({
    version: 1,
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
    name: "scalar-join",
    input: {},
    entry: "join",
    outputs: null,
    warnings: [],
    nodes: [
      {
        id: "join",
        kind: "join",
        scope: null,
        label: null,
        result: { kind: "value" as const, value: 42 },
      },
      {
        id: "format",
        kind: "format",
        scope: null,
        label: null,
        template: "{n}",
        values: { n: { ref: "join", path: [] } },
      },
    ],
    edges: [{ from: "join", to: "format", kind: "next" }],
  });

  expect(validateGraph(graph)).toEqual([]);
});

test("format accepts map items from a declared string array", () => {
  const graph: Graph = {
    ...mapGraph,
    input: { items: "string[]" },
    nodes: mapGraph.nodes.map((node) =>
      node.kind === "format"
        ? {
            ...node,
            values: {
              value: { ref: contract.decodeBoundary(contract.refIdSchema)("item"), path: [] },
            },
          }
        : node,
    ),
  };

  expect(contract.decodeBoundary(contract.graphSchema)(graph)).toEqual(graph);
  expect(validateGraph(graph)).toEqual([]);
});

test("finally preserves its body result type", () => {
  const graph = numericBranchGraph();
  graph.nodes = graph.nodes.map((node) =>
    node.id === "branch"
      ? contract.decodeBoundary(contract.nodeSchema)({
          id: node.id,
          kind: "finally",
          scope: null,
          label: null,
          body: "yes",
          cleanup: "no",
        })
      : node,
  );
  graph.edges = graph.edges.map((edge) =>
    edge.from === "branch" ? { ...edge, kind: edge.to === "yes" ? "next" : "cleanup" } : edge,
  );
  expect(validateGraph(graph)).toEqual([]);
});

test("command refs use their declared output fields", () => {
  const graph = structuredClone(approveDemoGraph);
  graph.nodes = graph.nodes.map((node) =>
    node.kind === "command"
      ? { ...node, out: { kind: "record", fields: { count: "number" } } }
      : node.id === "6:join" && node.kind === "join"
        ? {
            ...node,
            result: {
              kind: "value" as const,
              value: {
                ref: contract.decodeBoundary(contract.refIdSchema)("5:apply"),
                path: ["count"],
              },
            },
          }
        : node,
  );
  expect(validateGraph(graph)).toEqual([]);
  graph.nodes = graph.nodes.map((node) =>
    node.id === "6:join" && node.kind === "join"
      ? {
          ...node,
          result: {
            kind: "value" as const,
            value: {
              ref: contract.decodeBoundary(contract.refIdSchema)("5:apply"),
              path: ["missing"],
            },
          },
        }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);
});

for (const kind of ["yes", "no", "case", "each", "cleanup", "rescue"] as const) {
  test(`${kind} control edges reject the wrong owner`, () => {
    const graph = structuredClone(approveDemoGraph);
    graph.edges.push(
      kind === "case"
        ? contract.decodeBoundary(contract.edgeSchema)({
            from: "0:draft",
            to: "1:log",
            kind,
            label: "arm",
          })
        : contract.decodeBoundary(contract.edgeSchema)({ from: "0:draft", to: "1:log", kind }),
    );
    expect(validateGraph(graph).map((error) => error.code)).toEqual(["invalid_scope"]);
  });

  test(`${kind} control edges participate in cycle detection`, () => {
    const graph = structuredClone(approveDemoGraph);
    graph.edges.push(
      kind === "case"
        ? contract.decodeBoundary(contract.edgeSchema)({
            from: "1:log",
            to: "0:draft",
            kind,
            label: "arm",
          })
        : contract.decodeBoundary(contract.edgeSchema)({ from: "1:log", to: "0:draft", kind }),
    );
    expect(validateGraph(graph).map((error) => error.code)).toEqual(["invalid_scope", "cycle"]);
  });
}

test("control edges must match their owner's declared target", () => {
  const graph = structuredClone(approveDemoGraph);
  graph.edges = graph.edges.map((edge) =>
    edge.kind === "yes"
      ? { ...edge, to: contract.decodeBoundary(contract.nodeIdSchema)("7:fail") }
      : edge,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["invalid_scope"]);
});

test("cyclic join field projections produce diagnostics without recursing forever", () => {
  const graph = contract.decodeBoundary(contract.graphSchema)({
    version: 1,
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
    name: "cyclic-ref",
    input: {},
    entry: "join",
    outputs: null,
    warnings: [],
    nodes: [
      {
        id: "join",
        kind: "join",
        scope: null,
        label: null,
        result: { kind: "value" as const, value: { ref: "join", path: ["field"] } },
      },
    ],
    edges: [],
  });

  expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);
});

test("rescue results use the common body and handler type", () => {
  const graph = numericBranchGraph();
  graph.nodes = graph.nodes.map((node) =>
    node.id === "branch"
      ? contract.decodeBoundary(contract.nodeSchema)({
          id: node.id,
          kind: "rescue",
          scope: null,
          label: null,
          body: "yes",
          handler: "no",
          error: "error",
        })
      : node,
  );
  graph.edges = graph.edges.map((edge) =>
    edge.from === "branch" ? { ...edge, kind: edge.to === "yes" ? "next" : "rescue" } : edge,
  );
  expect(validateGraph(graph)).toEqual([]);
  graph.nodes = graph.nodes.map((node) =>
    node.id === "no" && node.kind === "join"
      ? { ...node, result: { kind: "value" as const, value: "different" } }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["predicate_type"]);
});

for (const [yes, no, member] of [
  [[1], [2], 1],
  [["a"], ["b"], "a"],
  [[true], [false], true],
  [[1, "a"], [false, null], null],
  [[], [], null],
] satisfies [core.Value[], core.Value[], core.Value][]) {
  test(`literal array branch results preserve element types for ${JSON.stringify(yes)}`, () => {
    const graph = numericBranchGraph();
    const result = { ref: contract.decodeBoundary(contract.refIdSchema)("result"), path: [] };
    graph.nodes = graph.nodes.map((node) =>
      node.kind === "join" && (node.id === "yes" || node.id === "no")
        ? { ...node, result: { kind: "value" as const, value: node.id === "yes" ? yes : no } }
        : node.id === "check" && node.kind === "branch"
          ? { ...node, predicate: { op: "gt", left: { ...result, size: true }, right: 0 } }
          : node,
    );
    expect(validateGraph(graph)).toEqual([]);
    graph.nodes = graph.nodes.map((node) =>
      node.id === "check" && node.kind === "branch"
        ? { ...node, predicate: { op: "in", left: member, right: result } }
        : node,
    );
    expect(validateGraph(graph).map((error) => error.code)).toEqual(
      member === null ? ["predicate_type"] : [],
    );
  });
}

for (const result of [
  { nested: { count: 1 } },
  { nested: { ref: "input", path: [] } },
  { nested: { count: { ref: "input", path: ["count"] } } },
]) {
  test(`format resolves literal join paths through ${JSON.stringify(result)}`, () => {
    const graph = contract.decodeBoundary(contract.graphSchema)({
      version: 1,
      meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
      name: "literal-path",
      input: { count: "number" },
      entry: "join",
      outputs: null,
      warnings: [],
      nodes: [
        {
          id: "join",
          kind: "join",
          scope: null,
          label: null,
          result: { kind: "value" as const, value: result },
        },
        {
          id: "format",
          kind: "format",
          scope: null,
          label: null,
          template: "{n}",
          values: { n: { ref: "join", path: ["nested", "count"] } },
        },
      ],
      edges: [{ from: "join", to: "format", kind: "next" }],
    });

    expect(validateGraph(graph)).toEqual([]);
  });
}

test("parallel result paths resolve each labelled arm through its join", () => {
  const graph = numericBranchGraph();
  graph.nodes = graph.nodes.map((node) =>
    node.id === "branch"
      ? contract.decodeBoundary(contract.nodeSchema)({
          id: node.id,
          kind: "parallel",
          scope: null,
          label: null,
          branches: { a: "yes", b: "no" },
        })
      : node.kind === "branch" && node.id === "check"
        ? {
            ...node,
            predicate: {
              op: "gt",
              left: { ref: contract.decodeBoundary(contract.refIdSchema)("branch"), path: ["a"] },
              right: 0,
            },
          }
        : node.kind === "join" && node.id === "result"
          ? {
              ...node,
              result: {
                kind: "value" as const,
                value: {
                  ref: contract.decodeBoundary(contract.refIdSchema)("branch"),
                  path: ["a"],
                },
              },
            }
          : node,
  );
  graph.edges = graph.edges.map((edge) =>
    edge.from === "branch"
      ? contract.decodeBoundary(contract.edgeSchema)({
          ...edge,
          kind: "case",
          label: edge.to === "yes" ? "a" : "b",
        })
      : edge,
  );
  expect(validateGraph(graph)).toEqual([]);
  const resolve = graphTypeResolver(graph);
  expect(resolve({ ref: "branch", path: [] })).toBe("object");
  expect(resolve({ ref: "branch", path: ["a"] })).toBe("number");
  expect(resolve({ ref: "branch", path: ["missing"] })).toBeNull();
});

test("rescue error binding resolves the shared record fields", () => {
  const graph = contract.decodeBoundary(contract.graphSchema)({
    ...numericBranchGraph(),
    nodes: [
      {
        id: "rescue",
        kind: "rescue",
        scope: null,
        label: null,
        body: "body",
        handler: "handler",
        error: "rescue:error",
      },
      { id: "body", kind: "fail", scope: "rescue", label: null, message: "failed" },
      {
        id: "handler",
        kind: "format",
        scope: "rescue",
        label: null,
        template: "{message}:{code}",
        values: {
          message: { ref: "rescue:error", path: ["message"] },
          code: { ref: "rescue:error", path: ["code"] },
        },
      },
    ],
    entry: "rescue",
    outputs: null,
    edges: [],
  });

  expect(validateGraph(graph)).toEqual([]);
  const resolve = graphTypeResolver(graph);

  for (const [field, type] of Object.entries(ERROR_FIELDS)) {
    expect(resolve({ ref: "rescue:error", path: [field] })).toBe(type);
  }

  expect(resolve({ ref: "rescue:error", path: ["missing"] })).toBeNull();
});

for (const type of FIELD_TYPES) {
  test(`value output ${type} resolves without permitting scalar or array paths`, () => {
    const graph = structuredClone(approveDemoGraph);
    graph.nodes = graph.nodes.map((node) =>
      node.kind === "code"
        ? { ...node, out: { kind: "value", type } }
        : node.kind === "format"
          ? { ...node, values: {} }
          : node,
    );
    const resolve = graphTypeResolver(graph);
    expect(resolve({ ref: "0:draft", path: [] })).toBe(type);

    for (const path of [["0"], ["length"], ["toString"]]) {
      graph.outputs = { ref: contract.decodeBoundary(contract.refIdSchema)("0:draft"), path };
      expect(validateGraph(graph).map((error) => error.code)).toContain("unresolved_ref");
    }
  });
}

test("control unions reject paths that enter a scalar or array arm", () => {
  const graph = numericBranchGraph();
  graph.nodes = graph.nodes.map((node) =>
    node.kind === "join" && node.id === "yes"
      ? { ...node, result: { kind: "value" as const, value: { field: "value" } } }
      : node.id === "check" && node.kind === "branch"
        ? {
            ...node,
            predicate: {
              op: "exists",
              value: {
                ref: contract.decodeBoundary(contract.refIdSchema)("branch"),
                path: ["field"],
              },
            },
          }
        : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);
});

for (const kind of ["branch", "rescue"] as const) {
  test(`${kind} ignores a non-returning arm when resolving its result`, () => {
    const graph = numericBranchGraph();
    graph.nodes = graph.nodes.map((node) =>
      node.id === "yes"
        ? contract.decodeBoundary(contract.nodeSchema)({
            id: node.id,
            kind: "fail",
            scope: node.scope,
            label: null,
            message: "oops",
          })
        : node.id === "branch" && kind === "rescue"
          ? contract.decodeBoundary(contract.nodeSchema)({
              id: node.id,
              kind,
              scope: null,
              label: null,
              body: "yes",
              handler: "no",
              error: "error",
            })
          : node,
    );
    graph.edges = graph.edges
      .filter((edge) => edge.from !== "yes")
      .map((edge) =>
        edge.from === "branch" && kind === "rescue"
          ? { ...edge, kind: edge.to === "yes" ? "next" : "rescue" }
          : edge,
      );

    expect(graphTypeResolver(graph)({ ref: "branch", path: [] })).toBe("number");
    expect(validateGraph(graph)).toEqual([]);
  });
}

test("a branch with no returning arms has an unresolved result reference", () => {
  const graph = numericBranchGraph();
  graph.nodes = graph.nodes
    .filter((node) => !["check", "pass", "fail"].includes(node.id))
    .map((node) =>
      node.id === "yes" || node.id === "no"
        ? contract.decodeBoundary(contract.nodeSchema)({
            id: node.id,
            kind: "fail",
            scope: "branch",
            label: null,
            message: "oops",
          })
        : node,
    );
  graph.edges = graph.edges.filter((edge) => edge.from === "branch");
  graph.edges.push(
    contract.decodeBoundary(contract.edgeSchema)({ from: "branch", to: "result", kind: "next" }),
  );

  expect(graphTypeResolver(graph)({ ref: "branch", path: [] })).toBe("never");
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);
});

for (const field of ["toString", "constructor", "__proto__"]) {
  test(`record paths require an own declaration for ${field}`, () => {
    const graph = structuredClone(approveDemoGraph);
    graph.outputs = {
      ref: contract.decodeBoundary(contract.refIdSchema)("0:draft"),
      path: [field],
    };
    expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);

    for (const key of [field, `${field}?`]) {
      graph.nodes = graph.nodes.map((node) =>
        node.kind === "code"
          ? { ...node, out: { kind: "record", fields: { [key]: "number" } } }
          : node,
      );
      expect(graphTypeResolver(graph)({ ref: "0:draft", path: [field] })).toBe("number");
    }
  });

  test(`parallel paths reject undeclared label ${field}`, () => {
    const graph = contract.decodeBoundary(contract.graphSchema)({
      ...numericBranchGraph(),
      nodes: [
        { id: "parallel", kind: "parallel", scope: null, label: null, branches: { a: "a" } },
        {
          id: "a",
          kind: "join",
          scope: "parallel",
          label: null,
          result: { kind: "value" as const, value: 1 },
        },
      ],
      entry: "parallel",
      outputs: { ref: "parallel", path: [field] },
      edges: [],
    });

    const parallel = graph.nodes.find((node) => node.kind === "parallel");

    if (parallel?.kind === "parallel") {
      Object.setPrototypeOf(parallel.branches, { [field]: "a" });
    }

    expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);
  });

  for (const kind of ["switch", "parallel"] as const) {
    test(`${kind} edges reject inherited target ${field}`, () => {
      const graph = numericBranchGraph();
      graph.nodes = graph.nodes.map((node) =>
        node.id === "branch"
          ? contract.decodeBoundary(contract.nodeSchema)({
              id: node.id,
              kind,
              scope: null,
              label: null,
              ...(kind === "switch"
                ? { on: { ref: "input", path: [] }, cases: { a: "yes" }, default: "no" }
                : { branches: { a: "yes", b: "no" } }),
            })
          : node,
      );
      const control = graph.nodes.find((node) => node.id === "branch");

      if (control?.kind === "switch" || control?.kind === "parallel") {
        Object.setPrototypeOf(control.kind === "switch" ? control.cases : control.branches, {
          [field]: "yes",
        });
      }

      graph.edges = graph.edges.map((edge) =>
        edge.from === "branch"
          ? {
              ...edge,
              kind: "case",
              label: edge.to === "yes" ? field : kind === "switch" ? "default" : "b",
            }
          : edge,
      );
      expect(validateGraph(graph).map((error) => error.code)).toContain("invalid_scope");
    });
  }
}

for (const label of ["__proto__", "constructor", "prototype"]) {
  test(`core rejects reserved labels and fields named ${label}`, () => {
    const graph = numericBranchGraph();

    const cases: Graph[] = [
      { ...graph, nodes: graph.nodes.map((node) => ({ ...node, label })) },
      { ...graph, input: { [label]: "string" } },
      { ...graph, input: { [`${label}?`]: "string" } },
      {
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.kind === "join"
            ? { ...node, result: { kind: "value", value: { [label]: 1 } } }
            : node,
        ),
      },
      {
        ...approveDemoGraph,
        nodes: approveDemoGraph.nodes.map((node) =>
          node.kind === "code"
            ? {
                ...node,
                in: { [label]: 1 },
                out: { kind: "record", fields: { [label]: "number" } },
              }
            : node,
        ),
      },
      {
        ...approveDemoGraph,
        nodes: approveDemoGraph.nodes.map((node) =>
          node.kind === "wait"
            ? { ...node, payload: { kind: "record", fields: { [label]: "number" } } }
            : node,
        ),
      },
      {
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.kind === "branch" && node.id === "branch"
            ? { ...node, kind: "parallel", branches: { [label]: node.arms.yes, b: node.arms.no } }
            : node,
        ),
      },
      {
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.kind === "branch" && node.id === "branch"
            ? {
                ...node,
                kind: "switch",
                on: { ref: contract.decodeBoundary(contract.refIdSchema)("input"), path: [] },
                cases: { [label]: node.arms.yes },
                default: node.arms.no,
              }
            : node,
        ),
      },
      {
        ...graph,
        edges: [
          ...graph.edges,
          {
            from: graph.entry,
            to: contract.decodeBoundary(contract.nodeIdSchema)("yes"),
            kind: "case",
            label,
          },
        ],
      },
    ];

    for (const candidate of cases) {
      expect(
        validateGraph(candidate)
          .filter(({ code }) => code === "reserved_name")
          .map(({ message }) => message),
      ).toContain(
        `Label "${candidate.input !== "schema" && Object.hasOwn(candidate.input, `${label}?`) ? `${label}?` : label}" is reserved`,
      );
    }
  });
}

test("none joins resolve to never without a plumbing reference", () => {
  const graph = contract.decodeBoundary(contract.graphSchema)({
    version: 1,
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
    name: "none",
    input: {},
    entry: "none",
    outputs: null,
    warnings: [],
    nodes: [{ id: "none", kind: "join", label: null, scope: null, result: { kind: "none" } }],
    edges: [],
  });

  expect(graphTypeResolver(graph)({ ref: "none", path: [] })).toBe("never");
  expect(validateGraph(graph)).toEqual([]);
  graph.outputs = contract.decodeBoundary(contract.refSchema)({ ref: "none", path: [] });
  expect(validateGraph(graph).map(({ code }) => code)).toEqual(["unresolved_ref"]);
});

for (const name of ["__proto__", "constructor", "prototype"]) {
  test(`wire parsing rejects reserved key ${name} before it can be dropped`, () => {
    const base = { id: "node", label: null, scope: null };

    const nodes = [
      { ...base, kind: "parallel", branches: { [name]: "arm" } },
      {
        ...base,
        kind: "switch",
        on: { ref: "input", path: [] },
        cases: { [name]: "arm" },
        default: null,
      },
      {
        ...base,
        kind: "wait",
        timeout: null,
        payload: { kind: "record", fields: { [name]: "number" } },
      },
      { ...base, kind: "join", result: { kind: "value", value: { [name]: 1 } } },
    ];

    for (const node of nodes) {
      expect(
        Schema.decodeUnknownExit(contract.nodeSchema)(node, { onExcessProperty: "error" })._tag ===
          "Success",
      ).toBe(false);
    }

    expect(
      Schema.decodeUnknownExit(contract.graphSchema)(
        { ...approveDemoGraph, input: { [name]: "number" } },
        { onExcessProperty: "error" },
      )._tag === "Success",
    ).toBe(false);
  });
}

for (const name of ["__proto__", "constructor", "prototype"]) {
  const base = { id: "node", label: null, scope: null };

  for (const label of [name, `${name}?`]) {
    const sites = [
      ["node label", contract.nodeSchema, { ...base, kind: "uuid", label }],
      ["case-edge label", contract.edgeSchema, { from: "node", to: "arm", kind: "case", label }],
      [
        "parallel arm",
        contract.nodeSchema,
        { ...base, kind: "parallel", branches: { [label]: "arm" } },
      ],
      [
        "switch arm",
        contract.nodeSchema,
        {
          ...base,
          kind: "switch",
          on: { ref: "input", path: [] },
          cases: { [label]: "arm" },
          default: null,
        },
      ],
      ["input field", contract.graphSchema, { ...approveDemoGraph, input: { [label]: "number" } }],
      ["output field", contract.outputSchema, { kind: "record", fields: { [label]: "number" } }],
      [
        "wait field",
        contract.nodeSchema,
        {
          ...base,
          kind: "wait",
          timeout: null,
          payload: { kind: "record", fields: { [label]: "number" } },
        },
      ],
    ] as const;

    for (const [site, schema, value] of sites) {
      test(`wire rejects reserved ${site} ${label}`, () => {
        expect(
          Schema.decodeUnknownExit(schema)(value, { onExcessProperty: "error" })._tag === "Success",
        ).toBe(false);
      });
    }
  }
}

test("parser input references use the same graph visibility checks as command arguments", () => {
  const graph = {
    ...approveDemoGraph,
    nodes: approveDemoGraph.nodes.map((node) =>
      node.kind === "command"
        ? {
            ...node,
            parse: {
              bundleHash: null,
              input: {
                args: [{ ref: contract.decodeBoundary(contract.refIdSchema)("missing"), path: [] }],
              },
            },
          }
        : node,
    ),
  };

  expect(validateGraph(graph).map((value) => value.code)).toContain("unresolved_ref");
});
