import { expect, test } from "bun:test";
import { validateGraph, validateGraphInput } from "../src";
import { inputGraph } from "./fixtures/graphs";

function graph() {
  return inputGraph({ paths: "string[]" }, { minItems: { paths: 1 }, unknownKeys: "strip" });
}

test("nonempty array input rejects empty and malformed values before execution", () => {
  const definition = graph();

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
  const scalar = graph();
  scalar.input = { paths: "string" };
  const missing = inputGraph({}, { minItems: { missing: 1 }, unknownKeys: "reject" });

  expect(validateGraph(scalar).map((item) => item.message)).toEqual([
    "Input minimum 'paths' requires an array field.",
  ]);
  expect(validateGraph(missing).map((item) => item.message)).toEqual([
    "Input minimum 'missing' requires an array field.",
  ]);
});

test("open records retain unknown fields and defer missing optional references to execution", () => {
  const definition = inputGraph(
    { "message?": "json" },
    { minItems: {}, unknownKeys: "passthrough" },
  );

  expect(validateGraphInput(definition, { extra: 42 })).toEqual({ ok: true, value: { extra: 42 } });
  expect(validateGraphInput(definition, { message: 12, extra: [true] })).toEqual({
    ok: true,
    value: { message: 12, extra: [true] },
  });
});

test("JSON-root input contracts preserve all JSON values without pre-queue field checks", () => {
  const definition = inputGraph(
    { "config?": "json" },
    { minItems: {}, unknownKeys: "passthrough", root: "json" },
  );

  for (const input of [null, false, 7, "config", [1], { extra: true }]) {
    expect(validateGraphInput(definition, input)).toEqual({ ok: true, value: input });
  }
});
