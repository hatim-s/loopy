import { expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeBoundary } from "../src/contract";

test("dashboard json field coercion parses values and reports invalid JSON", async () => {
  const { coerceInput, inputFields } = await import("../../../apps/dashboard/src/lib/input-form");

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
  const { FIELD_TYPES } = await import("../src/core");
  const { graphSchema, outputSchema } = await import("../src/contract");
  const { graphInput } = await import("../src/cli/input");
  const { approveDemoGraph } = await import("./fixtures/graphs");

  const { coerceInput, inputFields } = await import("../../../apps/dashboard/src/lib/input-form");

  const output = decodeBoundary(outputSchema)({
    kind: "record",
    fields: JSON.parse(JSON.stringify(allFields)),
  });

  if (output.kind !== "record") {
    throw new Error("Expected a record output.");
  }

  const spec = output.fields;
  expect(spec).toEqual(allFields);
  expect(Object.values(allFields)).toEqual([...FIELD_TYPES]);
  expect(decodeBoundary(graphSchema)({ ...approveDemoGraph, input: spec }).input).toEqual(
    allFields,
  );

  const namedInput = Object.fromEntries(
    Object.entries(allValues).map(([key, value]) => [
      key,
      key === "text" ? allValues.text : JSON.stringify(value),
    ]),
  );

  const input = await Effect.runPromise(
    graphInput(spec, {
      home: "/unused",
      cwd: "/unused",
      values: {},
      positionals: [],
      namedInput,
    }),
  );

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
    const { graphInput } = await import("../src/cli/input");

    const { coerceInput, inputFields } = await import("../../../apps/dashboard/src/lib/input-form");

    const spec = { items: kind };
    await expect(
      Effect.runPromise(
        graphInput(spec, {
          home: "/unused",
          cwd: "/unused",
          values: {},
          positionals: [],
          namedInput: { items: JSON.stringify(invalid) },
        }),
      ),
    ).rejects.toThrow(`Input --items must be a ${kind}. Provide a valid value.`);
    expect(coerceInput(inputFields(spec), { items: JSON.stringify(invalid) })).toEqual({
      valid: false,
      issues: [{ key: "items", message: `Enter a ${kind} as JSON.` }],
    });
  });
}
