import { expect, test } from "bun:test";
import { canonicalJson, revision } from "@loopy/core";
import { Effect, Result } from "effect";
import { decodeBoundary, encodeBoundary, graphSchema, routes, valueSchema } from "../src";
import { validateCompiled } from "../src/server";

const graph = {
  version: 1,
  name: "empty",
  meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
  input: {},
  nodes: [{ kind: "join", result: { kind: "none" }, id: "entry", label: null, scope: null }],
  edges: [],
  entry: "entry",
  outputs: null,
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

test("scope decoding rejects invalid tuples with an actionable message", () => {
  expect(() =>
    decodeBoundary(routes.executions.query)({ scope: '[{"nodeId":"a","index":-1}]' }),
  ).toThrow("Scope must be a JSON array of {nodeId,index} tuples.");
});
