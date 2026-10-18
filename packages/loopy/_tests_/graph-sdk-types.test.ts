import { expect, expectTypeOf, test } from "bun:test";
import type { Json } from "../src/core/index.js";
import {
  code,
  defineCommand,
  eq,
  exists,
  fs,
  gt,
  gte,
  in_,
  isNull,
  loopy,
  lt,
  lte,
  ne,
  type Ref,
  size,
} from "../src/sdk/graph/index.js";

// This function is checked by tsc but never evaluated. Invalid author programs must not run.
function operandTypes(
  text: Ref<string>,
  number: Ref<number>,
  flag: Ref<boolean>,
  strings: Ref<string[]>,
  object: Ref<Json>,
) {
  eq(text, "hello");
  ne(number, 1);
  lt(text, "z");
  lte(0, number);
  gt(size(strings), 0);
  gte("z", text);
  in_(text, strings);
  in_(flag, [true, false]);
  exists(object);
  isNull(object);
  // @ts-expect-error Equality requires matching scalar types.
  eq(number, text);
  // @ts-expect-error Inequality requires matching scalar types.
  ne(text, 1);
  // @ts-expect-error Equality requires a ref as its left operand.
  eq(1, 1);
  // @ts-expect-error Opaque JSON is not a declared scalar.
  eq(object, "text");
  // @ts-expect-error Ordering cannot mix strings and numbers.
  lt(text, number);
  // @ts-expect-error Ordering cannot mix literal types.
  lte(1, "two");
  // @ts-expect-error Booleans have no ordering.
  gt(flag, true);
  // @ts-expect-error Arrays have no ordering.
  gte(strings, strings);
  // @ts-expect-error Membership requires the same element type.
  in_(number, strings);
  // @ts-expect-error Membership checks every literal element.
  in_(text, [1]);
  // @ts-expect-error Size cannot measure a number.
  size(number);
  // @ts-expect-error Size cannot measure arbitrary JSON.
  size(object);
  // @ts-expect-error Existence requires a ref.
  exists("literal");
  // @ts-expect-error Null checks require a ref.
  isNull(null);
  // @ts-expect-error Arrays do not expose numeric paths.
  strings.get(0);
  // @ts-expect-error Arrays do not expose stringified numeric paths.
  strings.get("0");
  // @ts-expect-error Arrays do not expose JavaScript properties.
  strings.get("length");
  // @ts-expect-error Scalars do not expose JavaScript methods.
  text.get("toUpperCase");
  // @ts-expect-error JSON has no declared record keys.
  object.get("unknown");
}

function schemaTypes() {
  const command = defineCommand(
    { key: "count", program: "count", parse: "./parse-count.ts" },
    { kind: "value", type: "number" },
  );

  expectTypeOf(command()).toEqualTypeOf<Ref<number>>();
  defineCommand(
    // @ts-expect-error Inline parser functions are not supported.
    { key: "wrong", program: "wrong", parse: () => "text" },
    { kind: "value", type: "number" },
  );
  defineCommand(
    // @ts-expect-error Inline parser functions are not supported.
    { key: "wrong", program: "wrong", parse: () => ({ count: "text" }) },
    { kind: "record", fields: { count: "number" } },
  );
  defineCommand({ key: "missing", program: "missing", parse: "./parse-count.ts" });

  const record = code("record", {
    in: {},
    out: { kind: "record", fields: { count: "number", items: "string[]", data: "json" } },
    module: "./record.ts",
  });

  // @ts-expect-error The schema declares no missing field.
  record.get("missing");
  // @ts-expect-error Record paths do not include prototype methods.
  record.get("toString");
  // @ts-expect-error Array fields do not permit nested paths.
  record.get("items").get("0");
  // @ts-expect-error JSON fields do not permit undeclared paths.
  record.get("data").get("arbitrary");
}

test("typecheck fixtures are present and parsed array outputs remain measurable", () => {
  expect(operandTypes).toBeFunction();
  expect(schemaTypes).toBeFunction();

  const result = loopy("array-parser", {
    input: {},
    run: () => {
      const files = fs.ls();
      expectTypeOf(files).toEqualTypeOf<Ref<string[]>>();
      gt(size(files), 0);

      return files;
    },
  });

  expect(result.diagnostics).toEqual([]);
});
