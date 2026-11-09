import { expect, test } from "bun:test";
import { Schema } from "effect";
import * as core from "../src";
import { ERROR_FIELDS, FIELD_TYPES, type Graph, graphTypeResolver, validateGraph } from "../src";
import { decode } from "./fixtures/decode";
import { approveDemoGraph, mapGraph, numericBranchGraph } from "./fixtures/graphs";

test("declared ref fields resolve and predicate size has a numeric comparison type", () => {
  const graph = structuredClone(approveDemoGraph);
  graph.nodes = graph.nodes.map((node) =>
    node.kind === "branch"
      ? {
          ...node,
          predicate: {
            op: "gt",
            left: {
              ref: decode(core.refIdSchema)("input"),
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
              ref: decode(core.refIdSchema)("0:draft"),
              path: ["missing"],
            },
            right: 0,
          },
        }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);
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

const jsonRef = { ref: decode(core.refIdSchema)("input"), path: ["data"] };

for (const op of ["lt", "lte", "gt", "gte"] as const) {
  test(`${op} rejects JSON and non-orderable declared types`, () => {
    for (const [left, right] of [
      [jsonRef, 1],
      [1, jsonRef],
      [true, false],
      ["a", 1],
    ]) {
      const predicate = decode(core.predicateSchema)({ op, left, right });
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
      validateGraph(withPredicate(decode(core.predicateSchema)({ op: "in", left, right }))).map(
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
                value: { ref: decode(core.refIdSchema)("input"), path },
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
      Schema.decodeUnknownExit(core.nodeSchema)(
        { ...format, values: { value } },
        { onExcessProperty: "error" },
      )._tag === "Success",
    ).toBe(false);
  }
});

test("array refs use the declared map result type for size and membership", () => {
  const done = decode(core.nodeIdSchema)("done");
  const mapRef = { ref: decode(core.refIdSchema)("map"), path: [] };

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
                  value: { ref: decode(core.refIdSchema)("body"), path: [] },
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
          yes: decode(core.nodeIdSchema)("yes"),
          no: decode(core.nodeIdSchema)("no"),
        },
        predicate: { op: "in", left: "value", right: mapRef },
      },
      {
        id: decode(core.nodeIdSchema)("yes"),
        kind: "uuid",
        scope: done,
        label: null,
      },
      {
        id: decode(core.nodeIdSchema)("no"),
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

test("numeric branch results allow ordering and reject string equality", () => {
  const graph = numericBranchGraph();
  expect(validateGraph(graph)).toEqual([]);
  graph.nodes = graph.nodes.map((node) =>
    node.id === "check" && node.kind === "branch"
      ? {
          ...node,
          predicate: {
            op: "eq",
            left: { ref: decode(core.refIdSchema)("branch"), path: [] },
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
      ? decode(core.nodeSchema)({
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
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["predicate_type"]);
});

test("format accepts a scalar join result", () => {
  const graph = decode(core.graphSchema)({
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
        ? {
            ...node,
            values: {
              value: { ref: decode(core.refIdSchema)("item"), path: [] },
            },
          }
        : node,
    ),
  };

  expect(decode(core.graphSchema)(graph)).toEqual(graph);
  expect(validateGraph(graph)).toEqual([]);
});

test("finally preserves its body result type", () => {
  const graph = numericBranchGraph();
  graph.nodes = graph.nodes.map((node) =>
    node.id === "branch"
      ? decode(core.nodeSchema)({
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
              value: {
                ref: decode(core.refIdSchema)("5:apply"),
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
              ref: decode(core.refIdSchema)("5:apply"),
              path: ["missing"],
            },
          },
        }
      : node,
  );
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);
});

test("cyclic join field projections produce diagnostics without recursing forever", () => {
  const graph = decode(core.graphSchema)({
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
      ? decode(core.nodeSchema)({
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
    const result = { ref: decode(core.refIdSchema)("result"), path: [] };
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
    const graph = decode(core.graphSchema)({
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
      ? decode(core.nodeSchema)({
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
              left: { ref: decode(core.refIdSchema)("branch"), path: ["a"] },
              right: 0,
            },
          }
        : node.kind === "join" && node.id === "result"
          ? {
              ...node,
              result: {
                kind: "value" as const,
                value: {
                  ref: decode(core.refIdSchema)("branch"),
                  path: ["a"],
                },
              },
            }
          : node,
  );
  expect(validateGraph(graph)).toEqual([]);
  const resolve = graphTypeResolver(graph);
  expect(resolve({ ref: "branch", path: [] })).toBe("object");
  expect(resolve({ ref: "branch", path: ["a"] })).toBe("number");
  expect(resolve({ ref: "branch", path: ["missing"] })).toBeNull();
});

test("rescue error binding resolves the shared record fields", () => {
  const graph = decode(core.graphSchema)({
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
      graph.outputs = { ref: decode(core.refIdSchema)("0:draft"), path };
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
                ref: decode(core.refIdSchema)("branch"),
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
        ? decode(core.nodeSchema)({
            id: node.id,
            kind: "fail",
            scope: node.scope,
            label: null,
            message: "oops",
          })
        : node.id === "branch" && kind === "rescue"
          ? decode(core.nodeSchema)({
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
    graph.edges = graph.edges.filter((edge) => edge.from !== "yes");

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
        ? decode(core.nodeSchema)({
            id: node.id,
            kind: "fail",
            scope: "branch",
            label: null,
            message: "oops",
          })
        : node,
    );
  graph.edges = graph.edges.filter((edge) => edge.from === "branch");
  graph.edges.push(decode(core.edgeSchema)({ from: "branch", to: "result", kind: "next" }));

  expect(graphTypeResolver(graph)({ ref: "branch", path: [] })).toBe("never");
  expect(validateGraph(graph).map((error) => error.code)).toEqual(["unresolved_ref"]);
});

for (const field of ["toString", "constructor", "__proto__"]) {
  test(`record paths require an own declaration for ${field}`, () => {
    const graph = structuredClone(approveDemoGraph);
    graph.outputs = {
      ref: decode(core.refIdSchema)("0:draft"),
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
    const graph = decode(core.graphSchema)({
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

test("none joins resolve to never without a plumbing reference", () => {
  const graph = decode(core.graphSchema)({
    version: 1,
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
    name: "none",
    input: {},
    entry: "none",
    outputs: null,
    nodes: [{ id: "none", kind: "join", label: null, scope: null, result: { kind: "none" } }],
    edges: [],
  });

  expect(graphTypeResolver(graph)({ ref: "none", path: [] })).toBe("never");
  expect(validateGraph(graph)).toEqual([]);
  graph.outputs = decode(core.refSchema)({ ref: "none", path: [] });
  expect(validateGraph(graph).map(({ code }) => code)).toEqual(["unresolved_ref"]);
});
