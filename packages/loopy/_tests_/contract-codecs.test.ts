import { expect, expectTypeOf, test } from "bun:test";
import { Effect, Result } from "effect";
import type { Graph, Json, Node, NodeRun, Ref, Value } from "../src/contract";
import { routes } from "../src/contract/api";
import { decodeBoundary, encodeBoundary } from "../src/contract/codec";
import { validateCompiled } from "../src/contract/compiled-validation";
import { overviewSchema } from "../src/contract/dashboard";
import { graphSchema, nodeSchema, valueSchema } from "../src/contract/graph";
import { jsonSchema } from "../src/contract/json";
import { runSnapshotViewSchema } from "../src/contract/views";
import type * as Core from "../src/core";
import { canonicalJson } from "../src/core/canonical-json";
import { revision } from "../src/core/revision";

const graph = {
  version: 1,
  name: "empty",
  meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
  input: {},
  nodes: [{ kind: "join", result: { kind: "none" }, id: "entry", label: null, scope: null }],
  edges: [],
  entry: "entry",
  outputs: null,
  warnings: [],
};

test("strict codecs reject nested private fields on decode and encode", () => {
  const input = { ...graph, nodes: [{ ...graph.nodes[0], private: true }] };
  expect(() => decodeBoundary(graphSchema)(input)).toThrow();
  expect(() => encodeBoundary(graphSchema)(input)).toThrow();
});

test("routes without query fields reject unexpected keys on decode and encode", () => {
  const schema = routes.run.query;
  expect(decodeBoundary(schema)({})).toEqual({});
  expect(encodeBoundary(schema)({})).toEqual({});
  expect(() => decodeBoundary(schema)({ logs: "false" })).toThrow();
  expect(() => encodeBoundary(schema)({ logs: "false" })).toThrow();
});

test("query defaults, Number coercion, last duplicate and scope normalization survive", () => {
  const decode = decodeBoundary(routes.runs.query);
  expect(decode({})).toEqual({ limit: 50 });
  expect(decode({ limit: " 0x10 ", waiting: "false" })).toEqual({ limit: 16, waiting: false });
  expect(decode(Object.fromEntries(new URLSearchParams("limit=1&limit=2")))).toEqual({ limit: 2 });
  expect(() => decode({ limit: "" })).toThrow();
  expect(() => decode({ waiting: "FALSE" })).toThrow();
  expect(
    decodeBoundary(routes.executions.query)({ scope: '[ { "index": 0, "nodeId": "a" } ]' }),
  ).toEqual({ scope: '[{"nodeId":"a","index":0}]', limit: 50 });
});

test("recursive values reject malformed refs and reserved own keys at every depth", () => {
  const decode = decodeBoundary(valueSchema);
  expect(decode({ nested: [{ ref: "input", path: ["a"] }] })).toEqual({
    nested: [{ ref: "input", path: ["a"] }],
  });

  for (const value of [
    { ref: "input" },
    { nested: { ref: 1, path: [] } },
    JSON.parse('{"nested":{"__proto__":1}}'),
    { "constructor?": 1 },
    { nested: Infinity },
  ]) {
    expect(() => decode(value)).toThrow();
  }
});

test("decoding a graph leaves revision bytes unchanged and compiled rejection is typed", async () => {
  const parsed = decodeBoundary(graphSchema)(graph);
  expect(canonicalJson(parsed)).toBe(canonicalJson(graph));
  const hash = await revision(parsed);

  const result = await Effect.runPromise(
    Effect.result(
      validateCompiled({
        graph: parsed,
        revision: hash,
        bundles: [],
        source: { path: "empty.ts", workspace: "fixture" },
        replace: false,
      }),
    ),
  );

  expect(Result.isSuccess(result)).toBe(true);

  const rejected = await Effect.runPromise(
    Effect.result(
      validateCompiled({
        graph: parsed,
        revision: "0".repeat(64),
        bundles: [],
        source: { path: "empty.ts", workspace: "fixture" },
        replace: false,
      }),
    ),
  );

  expect(Result.isFailure(rejected) && rejected.failure._tag).toBe("CompiledValidationError");
});

test("JSON rejects nonfinite numbers before a wire value can be serialized", () => {
  for (const value of [NaN, Infinity, -Infinity, { nested: Infinity }]) {
    expect(() => decodeBoundary(jsonSchema)(value)).toThrow();
  }
});

test("all plain number fields reject nonfinite input and JSON exponent overflow on decode and encode", () => {
  const command = {
    kind: "command",
    id: "cmd",
    label: null,
    scope: null,
    key: "test",
    out: { kind: "value", type: "json" },
    argv: [],
    flags: {},
    flagSpec: {
      path: [],
      flags: { v: { cli: "--v", kind: "number", order: 0 } },
      style: "equals",
      positionalSeparator: false,
      flagsAfterPositionals: false,
    },
    options: { cwd: null, env: {}, stdin: null },
    rateLimit: null,
    retry: { attempts: 1, backoff: "exponential", retryOnExit: false },
    okExitCodes: [0],
    parse: null,
  };

  expect(decodeBoundary(nodeSchema)(command).kind).toBe("command");

  for (const value of [NaN, Infinity, -Infinity, JSON.parse("1e400")]) {
    const invalid = {
      ...command,
      flagSpec: {
        ...command.flagSpec,
        flags: { v: { ...command.flagSpec.flags.v, order: value } },
      },
    };

    expect(() => decodeBoundary(nodeSchema)(invalid)).toThrow();
    expect(() => encodeBoundary(nodeSchema)(invalid)).toThrow();
    expect(() => decodeBoundary(overviewSchema.fields.bucketSeconds)(value)).toThrow();
    expect(() => encodeBoundary(overviewSchema.fields.bucketSeconds)(value)).toThrow();
    expect(() =>
      decodeBoundary(runSnapshotViewSchema.fields.truncatedOutputs)({ node: value }),
    ).toThrow();
    expect(() =>
      encodeBoundary(runSnapshotViewSchema.fields.truncatedOutputs)({ node: value }),
    ).toThrow();
  }
});

test("scope decoding rejects invalid tuples with an actionable message", () => {
  expect(() =>
    decodeBoundary(routes.executions.query)({ scope: '[{"nodeId":"a","index":-1}]' }),
  ).toThrow("Scope must be a JSON array of {nodeId,index} tuples.");
});

test("contract recursive collection types preserve core mutability in both directions", () => {
  expectTypeOf<Json>().toEqualTypeOf<Core.Json>();
  expectTypeOf<Graph>().toMatchTypeOf<Core.Graph>();
  expectTypeOf<Core.Graph>().toMatchTypeOf<Graph>();
  expectTypeOf<Node>().toMatchTypeOf<Core.Node>();
  expectTypeOf<Core.Node>().toMatchTypeOf<Node>();
  expectTypeOf<Value>().toMatchTypeOf<Core.Value>();
  expectTypeOf<Core.Value>().toMatchTypeOf<Value>();
  expectTypeOf<Ref>().toMatchTypeOf<Core.Ref>();
  expectTypeOf<Core.Ref>().toMatchTypeOf<Ref>();
  expectTypeOf<NodeRun>().toMatchTypeOf<Core.NodeRun>();
  expectTypeOf<Core.NodeRun>().toMatchTypeOf<NodeRun>();
});
