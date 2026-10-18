import { expect, test } from "bun:test";
import { coerceInput, inputFields } from "../../../apps/dashboard/src/lib/input-form.js";
import { graphInput } from "../src/cli/input.js";
import { graphSchema, outputSchema } from "../src/contract/index.js";
import { FIELD_TYPES } from "../src/core/index.js";
import { approveDemoGraph } from "./fixtures/graphs.js";

test("dashboard json field coercion parses values and reports invalid JSON", () => {
  const fields = inputFields({ data: "json", "extra?": "json" });
  expect(coerceInput(fields, { data: '{"nested":[true,null,2]}' })).toEqual({
    valid: true,
    value: { data: { nested: [true, null, 2] } },
  });
  expect(coerceInput(fields, { data: "null" })).toEqual({ valid: true, value: { data: null } });
  expect(coerceInput(fields, { data: "bad" })).toEqual({
    valid: false,
    issues: [{ key: "data", message: "Enter valid JSON." }],
  });
});

const allFields = {
  text: "string",
  count: "number",
  enabled: "boolean",
  data: "json",
  texts: "string[]",
  counts: "number[]",
  flags: "boolean[]",
  values: "json[]",
} as const;

const allValues = {
  text: "hello",
  count: 2,
  enabled: true,
  data: { nested: [null, true] },
  texts: ["a", "b"],
  counts: [1, 2],
  flags: [true, false],
  values: [null, 1, "a", { nested: [] }],
};

test("RecordSpec round-trips every field type through contracts and input boundaries", async () => {
  const output = outputSchema.parse({
    kind: "record",
    fields: JSON.parse(JSON.stringify(allFields)),
  });

  if (output?.kind !== "record") {
    throw new Error("Expected a record output.");
  }

  const spec = output.fields;
  expect(spec).toEqual(allFields);
  expect(Object.values(allFields)).toEqual([...FIELD_TYPES]);
  expect(graphSchema.parse({ ...approveDemoGraph, input: spec }).input).toEqual(allFields);

  const namedInput = Object.fromEntries(
    Object.entries(allValues).map(([key, value]) => [
      key,
      key === "text" ? allValues.text : JSON.stringify(value),
    ]),
  );

  const input = await graphInput(spec, {
    home: "/unused",
    cwd: "/unused",
    values: {},
    positionals: [],
    namedInput,
  });

  expect(input).toEqual(allValues);
  expect(coerceInput(inputFields(allFields), namedInput)).toEqual({
    valid: true,
    value: allValues,
  });
});

for (const [kind, invalid] of [
  ["string[]", [1]],
  ["number[]", ["1"]],
  ["boolean[]", ["true"]],
  ["json[]", {}],
] as const) {
  test(`${kind} rejects wrong elements or non-arrays at each input boundary`, async () => {
    const spec = { items: kind };
    await expect(
      graphInput(spec, {
        home: "/unused",
        cwd: "/unused",
        values: {},
        positionals: [],
        namedInput: { items: JSON.stringify(invalid) },
      }),
    ).rejects.toThrow(`Input --items must be a ${kind}. Provide a valid value.`);
    expect(coerceInput(inputFields(spec), { items: JSON.stringify(invalid) })).toEqual({
      valid: false,
      issues: [{ key: "items", message: `Enter a ${kind} as JSON.` }],
    });
  });
}
