import { expect, expectTypeOf, test } from "bun:test";
import type { z } from "zod";
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

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

test("graph schemas exactly match the portable model", () => {
  const graph: Equal<contract.Graph, core.Graph> = true;
  const predicate: Equal<z.infer<typeof contract.predicateSchema>, core.Predicate> = true;
  const reverse: Equal<core.Predicate, z.infer<typeof contract.predicateSchema>> = true;
  expect([graph, predicate, reverse]).toEqual([true, true, true]);
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
      Omit<core.Graph, "nodes" | "warnings"> & {
        warnings: {
          code: core.DiagnosticCode;
          message: string;
          nodeId: core.NodeId | null;
          label: string | null;
        }[];
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
});

test("approve-demo is the canonical JSON graph for the builder", () => {
  expect(contract.graphSchema.parse(approveDemoGraph)).toEqual(approveDemoGraph);
  expect(contract.graphSchema.parse(JSON.parse(JSON.stringify(approveDemoGraph)))).toEqual(
    approveDemoGraph,
  );
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
      values: { i: { ref: "index", path: [] }, value: "item" },
    },
    {
      id: "end",
      kind: "join",
      scope: "map",
      label: null,
      result: { value: { ref: "item", path: [] }, formatted: { ref: "body", path: [] } },
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

  expect(validateGraph(badCycle).map((error) => error.code)).toEqual(["invalid_scope", "cycle"]);
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

  const view = { ...approveDemoGraph, nodes, warnings: [] };
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
      validateGraph(withPredicate(contract.predicateSchema.parse({ op: "in", left, right }))).map(
        (error) => error.code,
      ),
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
        ? { ...node, result: { ref: contract.refIdSchema.parse("map"), path: [] } }
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

    expect(validateGraph(graph).map((error) => error.code)).toContain("predicate_type");
  }

  for (const value of [null, [], {}]) {
    const format = approveDemoGraph.nodes.find((node) => node.kind === "format");
    expect(contract.nodeSchema.safeParse({ ...format, values: { value } }).success).toBe(false);
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
  expect(contract.graphViewSchema.parse(view)).toEqual(view);
  expect(JSON.stringify(view)).not.toContain("/private/author.ts");
  expect(contract.graphViewSchema.safeParse({ ...view, warnings: graph.warnings }).success).toBe(
    false,
  );
});

test("predicate wire schema parses the complete vocabulary and rejects unknown ops", () => {
  for (const op of ["eq", "ne", "lt", "lte", "gt", "gte", "in"] as const) {
    const predicate = { op, left: 1, right: 1 };
    expect(JSON.stringify(contract.predicateSchema.parse(predicate))).toBe(
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
    expect(JSON.stringify(contract.predicateSchema.parse(predicate))).toBe(
      JSON.stringify(predicate),
    );
  }

  expect(contract.predicateSchema.safeParse({ op: "unknown" }).success).toBe(false);
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
      .filter((error) => error.code === "invalid_scope")
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
          to: contract.nodeIdSchema.parse(target),
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
  expect(codes).toContain("invalid_scope");
  expect(codes).toContain("out_of_scope_ref");
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
            ? { ...node, result: { ref: contract.refIdSchema.parse("body"), path: [] } }
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
      predicate.op === "in" ? ["predicate_type"] : [],
    );
  }
});

function numericBranchGraph(): Graph {
  return contract.graphSchema.parse({
    version: 1,
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
      { id: "yes", kind: "join", scope: "branch", label: null, result: 1 },
      { id: "no", kind: "join", scope: "branch", label: null, result: 2 },
      { id: "result", kind: "join", scope: null, label: null, result: { ref: "branch", path: [] } },
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
            left: { ref: contract.refIdSchema.parse("branch"), path: [] },
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
    node.id === "no" && node.kind === "join" ? { ...node, result: "wrong" } : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["predicate_type"]);
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
  graph.edges = graph.edges.map((edge) =>
    edge.from === "branch"
      ? { ...edge, kind: "case", label: edge.to === "yes" ? "yes" : "default" }
      : edge,
  );
  expect(validateGraph(graph)).toEqual([]);
  graph.nodes = graph.nodes.map((node) =>
    node.id === "no" && node.kind === "join" ? { ...node, result: "wrong" } : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["predicate_type"]);
});

test("format accepts a scalar join result", () => {
  const graph = contract.graphSchema.parse({
    version: 1,
    name: "scalar-join",
    input: {},
    entry: "join",
    outputs: null,
    warnings: [],
    nodes: [
      { id: "join", kind: "join", scope: null, label: null, result: 42 },
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
  graph.edges = graph.edges.map((edge) =>
    edge.from === "branch" ? { ...edge, kind: edge.to === "yes" ? "next" : "cleanup" } : edge,
  );
  expect(validateGraph(graph)).toEqual([]);
});

test("command refs use their declared output fields", () => {
  const graph = structuredClone(approveDemoGraph);
  graph.nodes = graph.nodes.map((node) =>
    node.kind === "command"
      ? { ...node, out: { count: "number" } }
      : node.id === "6:join" && node.kind === "join"
        ? { ...node, result: { ref: contract.refIdSchema.parse("5:apply"), path: ["count"] } }
        : node,
  );
  expect(validateGraph(graph)).toEqual([]);
  graph.nodes = graph.nodes.map((node) =>
    node.id === "6:join" && node.kind === "join"
      ? { ...node, result: { ref: contract.refIdSchema.parse("5:apply"), path: ["missing"] } }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);
});

for (const kind of ["yes", "no", "case", "each", "cleanup", "rescue"] as const) {
  test(`${kind} control edges reject the wrong owner`, () => {
    const graph = structuredClone(approveDemoGraph);
    graph.edges.push(
      kind === "case"
        ? contract.edgeSchema.parse({ from: "0:draft", to: "1:log", kind, label: "arm" })
        : contract.edgeSchema.parse({ from: "0:draft", to: "1:log", kind }),
    );
    expect(validateGraph(graph).map((error) => error.code)).toEqual(["invalid_scope"]);
  });

  test(`${kind} control edges participate in cycle detection`, () => {
    const graph = structuredClone(approveDemoGraph);
    graph.edges.push(
      kind === "case"
        ? contract.edgeSchema.parse({ from: "1:log", to: "0:draft", kind, label: "arm" })
        : contract.edgeSchema.parse({ from: "1:log", to: "0:draft", kind }),
    );
    expect(validateGraph(graph).map((error) => error.code)).toEqual(["invalid_scope", "cycle"]);
  });
}

test("control edges must match their owner's declared target", () => {
  const graph = structuredClone(approveDemoGraph);
  graph.edges = graph.edges.map((edge) =>
    edge.kind === "yes" ? { ...edge, to: contract.nodeIdSchema.parse("7:fail") } : edge,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["invalid_scope"]);
});

test("cyclic join field projections produce diagnostics without recursing forever", () => {
  const graph = contract.graphSchema.parse({
    version: 1,
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
        result: { ref: "join", path: ["field"] },
      },
    ],
    edges: [],
  });

  expect(validateGraph(graph).map((error) => error.code)).toEqual(["out_of_scope_ref"]);
});
