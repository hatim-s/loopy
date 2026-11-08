import { expect, test } from "bun:test";
import { Schema } from "effect";
import * as core from "../src";
import { type Graph, validateGraph } from "../src";
import { decode } from "./fixtures/decode";
import { approveDemoGraph, numericBranchGraph } from "./fixtures/graphs";

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
                on: { ref: decode(core.refIdSchema)("input"), path: [] },
                cases: { [label]: node.arms.yes },
                default: node.arms.no,
              }
            : node,
        ),
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
        Schema.decodeUnknownExit(core.nodeSchema)(node, { onExcessProperty: "error" })._tag ===
          "Success",
      ).toBe(false);
    }

    expect(
      Schema.decodeUnknownExit(core.graphSchema)(
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
      ["node label", core.nodeSchema, { ...base, kind: "uuid", label }],
      [
        "parallel arm",
        core.nodeSchema,
        { ...base, kind: "parallel", branches: { [label]: "arm" } },
      ],
      [
        "switch arm",
        core.nodeSchema,
        {
          ...base,
          kind: "switch",
          on: { ref: "input", path: [] },
          cases: { [label]: "arm" },
          default: null,
        },
      ],
      ["input field", core.graphSchema, { ...approveDemoGraph, input: { [label]: "number" } }],
      ["output field", core.outputSchema, { kind: "record", fields: { [label]: "number" } }],
      [
        "wait field",
        core.nodeSchema,
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

test("node id readers recover the subgraph path and local name the builder wrote", () => {
  expect(core.nodeIdParts(core.formatNodeId(7, ["deploy", "check"], "lint"))).toEqual({
    local: "deploy/check/lint",
    path: "deploy/check",
  });
  expect(core.nodeIdParts(core.formatNodeId(0, [], "draft"))).toEqual({ local: "draft", path: "" });
});
