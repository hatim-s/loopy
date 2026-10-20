import { expect, test } from "bun:test";
import { graphSchema } from "../src/contract/index.js";
import { validateGraph, validateGraphInput } from "../src/core/index.js";
import { loopy } from "../src/sdk/graph/index.js";

function graph() {
  return loopy("import-files", {
    input: { paths: "string[]" },
    inputValidation: { minItems: { paths: 1 }, unknownKeys: "strip" },
    run: ({ input }) => input,
  }).graph;
}

test("nonempty array input rejects empty and malformed values before execution", () => {
  const definition = graphSchema.parse(graph());

  expect(validateGraphInput(definition, { paths: [] }).ok).toBe(false);
  expect(validateGraphInput(definition, { paths: [12] }).ok).toBe(false);
  expect(validateGraphInput(definition, { paths: ["export.json"] })).toEqual({
    ok: true,
    value: { paths: ["export.json"] },
  });
});

test("schema unknown-key policy strips unrecognized inputs without mutating the caller", () => {
  const input = { paths: ["export.json"], unrelated: "ignored" };

  expect(validateGraphInput(graph(), input)).toEqual({
    ok: true,
    value: { paths: ["export.json"] },
  });
  expect(input.unrelated).toBe("ignored");
  expect(validateGraphInput({ input: { paths: "string[]" } }, input).ok).toBe(false);
});

test("minimum constraints cannot target a missing or scalar field", () => {
  const definition = graph();
  definition.input = { paths: "string" };

  expect(validateGraph(definition).map((item) => item.message)).toEqual([
    "Input minimum 'paths' requires an array field and a nonnegative integer.",
  ]);
  expect(() =>
    loopy("invalid-input", {
      input: {},
      inputValidation: { minItems: { missing: 1 }, unknownKeys: "reject" },
      run: () => null,
    }),
  ).toThrow("requires an array field");
});

test("open records retain unknown fields and defer missing optional references to execution", () => {
  const definition = loopy("open-input", {
    input: { "message?": "json" },
    inputValidation: { minItems: {}, unknownKeys: "passthrough" },
    run: ({ input }) => input,
  }).graph;

  expect(validateGraphInput(definition, { extra: 42 })).toEqual({ ok: true, value: { extra: 42 } });
  expect(validateGraphInput(definition, { message: 12, extra: [true] })).toEqual({
    ok: true,
    value: { message: 12, extra: [true] },
  });
});

test("JSON-root input contracts preserve all JSON values without pre-queue field checks", () => {
  const definition = loopy("json-input", {
    input: { "config?": "json" },
    inputValidation: { minItems: {}, unknownKeys: "passthrough", root: "json" },
    run: ({ input }) => input,
  }).graph;

  for (const input of [null, false, 7, "config", [1], { extra: true }]) {
    expect(validateGraphInput(definition, input)).toEqual({ ok: true, value: input });
  }
});
