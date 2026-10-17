import { expect, test } from "bun:test";

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
