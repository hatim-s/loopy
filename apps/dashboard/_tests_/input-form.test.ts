import { expect, test } from "bun:test";
import { coerceInput, initialValues, inputFields, parseJsonInput } from "../src/lib/input-form.ts";

const fields = inputFields({
  name: "string",
  "count?": "number",
  loud: "boolean",
  "quiet?": "boolean",
});

test("a trailing ? marks the field optional and drops from the key", () => {
  expect(fields).toEqual([
    { key: "name", kind: "string", optional: false },
    { key: "count", kind: "number", optional: true },
    { key: "loud", kind: "boolean", optional: false },
    { key: "quiet", kind: "boolean", optional: true },
  ]);
});

test("required booleans start false and everything else starts empty", () => {
  expect(initialValues(fields)).toEqual({ name: "", count: "", loud: "false", quiet: "" });
});

test("form text becomes typed JSON and empty optional fields are left out", () => {
  expect(coerceInput(fields, { name: "Ada", count: "", loud: "true", quiet: "" })).toEqual({
    valid: true,
    value: { name: "Ada", loud: true },
  });

  expect(
    coerceInput(fields, { name: " Ada ", count: " 2.5 ", loud: "false", quiet: "false" }),
  ).toEqual({
    valid: true,
    value: { name: " Ada ", count: 2.5, loud: false, quiet: false },
  });
});

test("an empty required field and a non-number are issues, not coerced values", () => {
  expect(coerceInput(fields, { name: "  ", count: "12abc", loud: "false", quiet: "" })).toEqual({
    valid: false,
    issues: [
      { key: "name", message: "Required." },
      { key: "count", message: "Enter a number." },
    ],
  });
});

test("the JSON editor accepts any JSON value and rejects text that is not JSON", () => {
  expect(parseJsonInput('{"a":[1,true,null]}')).toEqual({
    valid: true,
    value: { a: [1, true, null] },
  });
  expect(parseJsonInput("{a:1}")).toEqual({ valid: false });
});
