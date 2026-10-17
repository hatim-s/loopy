import { expect, test } from "bun:test";
import type { Json } from "../src/core/index.js";

test("dashboard json field coercion parses values and reports invalid JSON", async () => {
  const { coerceInput, inputFields } = await import(
    "../../../apps/dashboard/src/lib/input-form.js"
  );

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
  const { expectTypeOf } = await import("bun:test");
  const { FIELD_TYPES } = await import("../src/core/index.js");
  const { graphSchema, outputSchema } = await import("../src/contract/index.js");
  const { sdkInput } = await import("../src/cli/input.js");
  const { loopy } = await import("../src/sdk/index.js");
  const { inputValidator } = await import("../src/sdk/schema.js");
  const { approveDemoGraph } = await import("./fixtures/graphs.js");

  const { coerceInput, inputFields } = await import(
    "../../../apps/dashboard/src/lib/input-form.js"
  );

  const spec = outputSchema.parse(JSON.parse(JSON.stringify(allFields)));
  expect(spec).toEqual(allFields);
  expect(Object.values(allFields)).toEqual([...FIELD_TYPES]);
  expect(graphSchema.parse({ ...approveDemoGraph, input: spec }).input).toEqual(allFields);

  const namedInput = Object.fromEntries(
    Object.entries(allValues).map(([key, value]) => [
      key,
      key === "text" ? allValues.text : JSON.stringify(value),
    ]),
  );

  const definition = loopy({
    name: "all-fields",
    input: allFields,
    run: async ({ input }) => input,
  });

  const input = await sdkInput(definition, {
    home: "/unused",
    cwd: "/unused",
    values: {},
    positionals: [],
    namedInput,
  });

  expect(input).toEqual(allValues);
  const validated = await inputValidator(allFields)(input);
  expectTypeOf(validated).toEqualTypeOf<{
    text: string;
    count: number;
    enabled: boolean;
    data: Json;
    texts: string[];
    counts: number[];
    flags: boolean[];
    values: Json[];
  }>();
  expect(validated).toEqual(allValues);
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
    const { sdkInput } = await import("../src/cli/input.js");
    const { loopy } = await import("../src/sdk/index.js");
    const { inputValidator } = await import("../src/sdk/schema.js");

    const { coerceInput, inputFields } = await import(
      "../../../apps/dashboard/src/lib/input-form.js"
    );

    const spec = { items: kind };
    const definition = loopy({ name: "array-input", input: spec, run: async ({ input }) => input });
    await expect(inputValidator(spec)({ items: invalid })).rejects.toThrow(
      `items: Expected ${kind}`,
    );
    await expect(
      sdkInput(definition, {
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
    expect(await inputValidator(spec)({ items: [] })).toEqual({ items: [] });
  });
}
