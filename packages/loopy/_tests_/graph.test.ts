import { expect, test } from "bun:test";
import * as contract from "../src/contract/index.js";
import type * as core from "../src/core/index.js";
import {
  canonicalJson,
  checkPredicate,
  type DiagnosticCode,
  ERROR_FIELDS,
  executionKeyString,
  FIELD_TYPES,
  type Graph,
  graphTypeResolver,
  matchesRecord,
  validateGraph,
} from "../src/core/index.js";
import { approveDemoGraph } from "./fixtures/graphs.js";

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

broken("operand_type", (graph) => ({
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

broken(
  "missing_arm",
  (graph) => ({
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.kind === "branch"
        ? { ...node, arms: { ...node.arms, no: contract.nodeIdSchema.parse("missing") } }
        : node,
    ),
  }),
  ["unreachable"],
);

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
  meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
  name: "map",
  input: { items: "json" },
  entry: "map",
  outputs: { ref: "map", path: [] },
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

  expect(validateGraph(badCycle).map((error) => error.code)).toEqual(["scope_escape", "cycle"]);
});

test("parallel siblings cannot consume one another's results", () => {
  const graph = contract.graphSchema.parse({
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
  const graph = contract.graphSchema.parse({
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
      ? { ...node, message: { ref: contract.refIdSchema.parse("error"), path: ["message"] } }
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
      node.kind === "map" ? { ...node, index: contract.refIdSchema.parse("input") } : node,
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

const jsonRef = { ref: contract.refIdSchema.parse("input"), path: ["data"] };

for (const op of ["lt", "lte", "gt", "gte"] as const) {
  test(`${op} rejects JSON and non-orderable declared types`, () => {
    for (const [left, right] of [
      [jsonRef, 1],
      [1, jsonRef],
      [true, false],
      ["a", 1],
    ]) {
      const predicate = contract.predicateSchema.parse({ op, left, right });
      expect(validateGraph(withPredicate(predicate)).map((error) => error.code)).toContain(
        "operand_type",
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
      validateGraph(withPredicate(contract.predicateSchema.parse({ op: "in", left, right }))).map(
        (error) => error.code,
      ),
    ).toEqual(["operand_type"]);
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
              value: { ref: contract.refIdSchema.parse("map"), path: [] },
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
          ? { ...node, values: { value: { ref: contract.refIdSchema.parse("input"), path } } }
          : node,
      ),
    };

    expect(validateGraph(graph).map((error) => error.code)).toContain("operand_type");
  }

  for (const value of [null, [], {}]) {
    const format = approveDemoGraph.nodes.find((node) => node.kind === "format");
    expect(contract.nodeSchema.safeParse({ ...format, values: { value } }).success).toBe(false);
  }
});

test("disconnected nodes are diagnosed", () => {
  const graph = {
    ...approveDemoGraph,
    nodes: [
      ...approveDemoGraph.nodes,
      contract.nodeSchema.parse({ id: "orphan", kind: "uuid", label: null, scope: null }),
    ],
  };

  expect(
    validateGraph(graph)
      .filter((error) => error.code === "unreachable")
      .map((error) => error.node),
  ).toEqual([contract.nodeIdSchema.parse("orphan")]);
});

test("a second root with an edge into the graph is diagnosed", () => {
  const root = contract.nodeSchema.parse({ id: "root", kind: "uuid", label: null, scope: null });

  const graph = {
    ...approveDemoGraph,
    nodes: [...approveDemoGraph.nodes, root],
    edges: [
      ...approveDemoGraph.edges,
      { from: root.id, to: approveDemoGraph.entry, kind: "next" as const },
    ],
  };

  expect(validateGraph(graph).map((error) => error.code)).toContain("unreachable");
});

for (const target of ["5:apply", "6:join"]) {
  test(`outside edges cannot enter body node ${target}`, () => {
    const graph = {
      ...approveDemoGraph,
      edges: [
        ...approveDemoGraph.edges,
        {
          from: approveDemoGraph.entry,
          to: contract.nodeIdSchema.parse(target),
          kind: "next" as const,
        },
      ],
    };

    expect(validateGraph(graph).map((error) => error.code)).toContain("scope_escape");
  });
}

test("sibling arm edges cannot grant reference visibility", () => {
  const graph = {
    ...approveDemoGraph,
    nodes: approveDemoGraph.nodes.map((node) =>
      node.kind === "fail"
        ? { ...node, message: { ref: contract.refIdSchema.parse("4:format"), path: [] } }
        : node,
    ),
    edges: [
      ...approveDemoGraph.edges,
      {
        from: contract.nodeIdSchema.parse("4:format"),
        to: contract.nodeIdSchema.parse("7:fail"),
        kind: "next" as const,
      },
    ],
  };

  const codes = validateGraph(graph).map((error) => error.code);
  expect(codes).toContain("scope_escape");
});

test("array refs use the declared map result type for size and membership", () => {
  const done = contract.nodeIdSchema.parse("done");
  const mapRef = { ref: contract.refIdSchema.parse("map"), path: [] };

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
                  value: { ref: contract.refIdSchema.parse("body"), path: [] },
                },
              }
            : node,
      ),
      {
        id: done,
        kind: "branch",
        scope: null,
        label: null,
        arms: { yes: contract.nodeIdSchema.parse("yes"), no: contract.nodeIdSchema.parse("no") },
        predicate: { op: "in", left: "value", right: mapRef },
      },
      { id: contract.nodeIdSchema.parse("yes"), kind: "uuid", scope: done, label: null },
      { id: contract.nodeIdSchema.parse("no"), kind: "uuid", scope: done, label: null },
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
      predicate.op === "in" ? ["operand_type"] : [],
    );
  }
});

function numericBranchGraph(): Graph {
  return contract.graphSchema.parse({
    version: 1,
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
    name: "derived-types",
    input: {},
    entry: "branch",
    outputs: null,
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
            left: { ref: contract.refIdSchema.parse("branch"), path: [] },
            right: "wrong",
          },
        }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["operand_type"]);
});

test("a branch with mismatched arm results rejects ordering", () => {
  const graph = numericBranchGraph();
  graph.nodes = graph.nodes.map((node) =>
    node.id === "no" && node.kind === "join"
      ? { ...node, result: { kind: "value" as const, value: "wrong" } }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["operand_type"]);
});

test("switch results resolve through each arm's terminal join", () => {
  const graph = numericBranchGraph();
  graph.input = { choice: "string" };
  graph.nodes = graph.nodes.map((node) =>
    node.id === "branch"
      ? contract.nodeSchema.parse({
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
  expect(validateGraph(graph)).toEqual([]);
  graph.nodes = graph.nodes.map((node) =>
    node.id === "no" && node.kind === "join"
      ? { ...node, result: { kind: "value" as const, value: "wrong" } }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["operand_type"]);
});

test("format accepts a scalar join result", () => {
  const graph = contract.graphSchema.parse({
    version: 1,
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
    name: "scalar-join",
    input: {},
    entry: "join",
    outputs: null,
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
        ? { ...node, values: { value: { ref: contract.refIdSchema.parse("item"), path: [] } } }
        : node,
    ),
  };

  expect(contract.graphSchema.parse(graph)).toEqual(graph);
  expect(validateGraph(graph)).toEqual([]);
});

test("finally preserves its body result type", () => {
  const graph = numericBranchGraph();
  graph.nodes = graph.nodes.map((node) =>
    node.id === "branch"
      ? contract.nodeSchema.parse({
          id: node.id,
          kind: "finally",
          scope: null,
          label: null,
          body: "yes",
          cleanup: "no",
        })
      : node,
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
              value: { ref: contract.refIdSchema.parse("5:apply"), path: ["count"] },
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
            value: { ref: contract.refIdSchema.parse("5:apply"), path: ["missing"] },
          },
        }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);
});

test("cyclic join field projections produce diagnostics without recursing forever", () => {
  const graph = contract.graphSchema.parse({
    version: 1,
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
    name: "cyclic-ref",
    input: {},
    entry: "join",
    outputs: null,
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
      ? contract.nodeSchema.parse({
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
  expect(validateGraph(graph)).toEqual([]);
  graph.nodes = graph.nodes.map((node) =>
    node.id === "no" && node.kind === "join"
      ? { ...node, result: { kind: "value" as const, value: "different" } }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["operand_type"]);
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
    const result = { ref: contract.refIdSchema.parse("result"), path: [] };
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
      member === null ? ["operand_type"] : [],
    );
  });
}

for (const result of [
  { nested: { count: 1 } },
  { nested: { ref: "input", path: [] } },
  { nested: { count: { ref: "input", path: ["count"] } } },
]) {
  test(`format resolves literal join paths through ${JSON.stringify(result)}`, () => {
    const graph = contract.graphSchema.parse({
      version: 1,
      meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
      name: "literal-path",
      input: { count: "number" },
      entry: "join",
      outputs: null,
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
      ? contract.nodeSchema.parse({
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
              left: { ref: contract.refIdSchema.parse("branch"), path: ["a"] },
              right: 0,
            },
          }
        : node.kind === "join" && node.id === "result"
          ? {
              ...node,
              result: {
                kind: "value" as const,
                value: { ref: contract.refIdSchema.parse("branch"), path: ["a"] },
              },
            }
          : node,
  );
  expect(validateGraph(graph)).toEqual([]);
  const resolve = graphTypeResolver(graph);
  expect(resolve({ ref: contract.refIdSchema.parse("branch"), path: [] })).toBe("object");
  expect(resolve({ ref: contract.refIdSchema.parse("branch"), path: ["a"] })).toBe("number");
  expect(resolve({ ref: contract.refIdSchema.parse("branch"), path: ["missing"] })).toBeNull();
});

test("rescue error binding resolves the shared record fields", () => {
  const graph = contract.graphSchema.parse({
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
    expect(resolve({ ref: contract.refIdSchema.parse("rescue:error"), path: [field] })).toBe(type);
  }

  expect(
    resolve({ ref: contract.refIdSchema.parse("rescue:error"), path: ["missing"] }),
  ).toBeNull();
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
    expect(resolve({ ref: contract.refIdSchema.parse("0:draft"), path: [] })).toBe(type);

    for (const path of [["0"], ["length"], ["toString"]]) {
      graph.outputs = { ref: contract.refIdSchema.parse("0:draft"), path };
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
              value: { ref: contract.refIdSchema.parse("branch"), path: ["field"] },
            },
          }
        : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);
});

for (const field of ["toString", "constructor", "__proto__"]) {
  test(`record paths require an own declaration for ${field}`, () => {
    const graph = structuredClone(approveDemoGraph);
    graph.outputs = { ref: contract.refIdSchema.parse("0:draft"), path: [field] };
    expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);

    for (const key of [field, `${field}?`]) {
      graph.nodes = graph.nodes.map((node) =>
        node.kind === "code"
          ? { ...node, out: { kind: "record", fields: { [key]: "number" } } }
          : node,
      );
      expect(
        graphTypeResolver(graph)({ ref: contract.refIdSchema.parse("0:draft"), path: [field] }),
      ).toBe("number");
    }
  });

  test(`parallel paths reject undeclared label ${field}`, () => {
    const graph = contract.graphSchema.parse({
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
                on: { ref: contract.refIdSchema.parse("input"), path: [] },
                cases: { [label]: node.arms.yes },
                default: node.arms.no,
              }
            : node,
        ),
      },
    ];

    for (const candidate of cases) {
      expect(validateGraph(candidate).map(({ code }) => code)).toContain("reserved_name");
    }
  });
}

test("none joins resolve to never without a plumbing reference", () => {
  const graph = contract.graphSchema.parse({
    version: 1,
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
    name: "none",
    input: {},
    entry: "none",
    outputs: null,
    nodes: [{ id: "none", kind: "join", label: null, scope: null, result: { kind: "none" } }],
    edges: [],
  });

  expect(graphTypeResolver(graph)({ ref: contract.refIdSchema.parse("none"), path: [] })).toBe(
    "never",
  );
  expect(validateGraph(graph)).toEqual([]);
  graph.outputs = contract.refSchema.parse({ ref: contract.refIdSchema.parse("none"), path: [] });
  expect(validateGraph(graph).map(({ code }) => code)).toEqual(["unresolved_ref"]);
});

test("parser input references use the same graph visibility checks as command arguments", () => {
  const graph = {
    ...approveDemoGraph,
    nodes: approveDemoGraph.nodes.map((node) =>
      node.kind === "command"
        ? {
            ...node,
            parse: {
              bundleHash: null,
              input: { args: [{ ref: contract.refIdSchema.parse("missing"), path: [] }] },
            },
          }
        : node,
    ),
  };

  expect(validateGraph(graph).map((value) => value.code)).toContain("unresolved_ref");
});

test("a map of records compares with a declared json array", () => {
  const declared = contract.nodeSchema.parse({
    id: "declared",
    kind: "code",
    scope: null,
    label: null,
    in: {},
    out: { kind: "value", type: "json[]" },
    module: { path: "./records.ts", bundleHash: null },
    rateLimit: null,
    retry: { attempts: 1, backoff: "exponential", retryOnExit: false },
    timeout: null,
  });

  const graph = {
    ...mapGraph,
    nodes: [
      ...mapGraph.nodes.map((node) =>
        node.kind === "map" ? { ...node, onError: "fail" as const } : node,
      ),
      declared,
    ],
  };

  const resolve = graphTypeResolver(graph);
  const left = contract.refSchema.parse({ ref: "map", path: [] });
  const right = contract.refSchema.parse({ ref: "declared", path: [] });
  expect(resolve(left)).toBe("json[]");
  expect(checkPredicate({ op: "eq", left, right }, resolve)).toEqual([]);
});

test("record matching distinguishes input keys from JSON output extensions", () => {
  const spec = { name: "string", "count?": "number" } as const;
  const extended = { name: "Ada", detail: { ready: true } };
  expect(matchesRecord(spec, { name: "Ada" }, { extraKeys: "reject" })).toBe(true);
  expect(matchesRecord(spec, extended, { extraKeys: "reject" })).toBe(false);
  expect(matchesRecord(spec, extended, { extraKeys: "allow" })).toBe(true);
  expect(matchesRecord(spec, { name: "Ada", count: "1" }, { extraKeys: "allow" })).toBe(false);
  const cyclic = { name: "Ada", self: { name: "Ada" } };
  cyclic.self = cyclic;
  expect(matchesRecord(spec, cyclic, { extraKeys: "allow" })).toBe(false);
  expect(matchesRecord({ values: "json[]" }, { values: Array(1) }, { extraKeys: "reject" })).toBe(
    false,
  );
});

test("canonical JSON sorts nested keys and preserves array order", () => {
  expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: null })).toBe('{"a":null,"z":[{"a":1,"b":2}]}');
});
