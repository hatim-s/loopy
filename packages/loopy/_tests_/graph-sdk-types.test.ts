import { expect, expectTypeOf, test } from "bun:test";
import type { Json } from "../src/core/index.js";
import type { CommandInput } from "../src/sdk/graph/command-input.js";
import {
  branch,
  code,
  defineCommand,
  eq,
  exists,
  fail,
  finally_,
  fs,
  gt,
  gte,
  in_,
  isNull,
  log,
  loopy,
  lt,
  lte,
  ne,
  parallel,
  type Ref,
  rescue,
  size,
  subgraph,
  switch_,
  wait,
} from "../src/sdk/index.js";

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
  // @ts-expect-error A parser needs a declared output.
  defineCommand({ key: "missing", program: "missing", parse: "./parse-count.ts" });
  defineCommand(
    // @ts-expect-error Output is declared in one place only.
    { key: "twice", program: "twice", parse: "./parse-count.ts", out: "number" },
    "number",
  );

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

function controlTypes(text: Ref<string>, number: Ref<number>) {
  const record = () => code("record", { in: {}, out: { count: "number" }, module: "./record.ts" });
  const selected = branch(eq(number, 1), { yes: record, no: record });
  expectTypeOf(selected.get("count")).toEqualTypeOf<Ref<number>>();
  // @ts-expect-error Raw predicates have no SDK brand.
  branch({ op: "eq", left: 1, right: 1 }, { yes: () => 1, no: () => 0 });

  const switched = switch_(text, { first: record, default: record });
  expectTypeOf(switched).toEqualTypeOf<Ref<{ count: number }, { count: number }>>();
  // @ts-expect-error Every switch arm declares only count.
  switched.get("missing");

  const grouped = parallel({ text: () => text, count: () => number });
  expectTypeOf(grouped).toEqualTypeOf<
    Ref<{ text: string; count: number }, { text: string; count: number }>
  >();
  // @ts-expect-error Parallel exposes only declared arm names.
  grouped.get("missing");

  const cleaned = finally_(record, () => log("cleanup"));
  expectTypeOf(cleaned).toEqualTypeOf<Ref<{ count: number }, { count: number }>>();
  // @ts-expect-error Cleanup does not add output fields.
  cleaned.get("cleanup");

  const caught = rescue(
    () => number,
    () => text,
  );

  expectTypeOf(caught).toEqualTypeOf<Ref<number | string>>();
  // @ts-expect-error Scalar rescue unions have no record projection.
  caught.get("count");
  const recoveredRecord = rescue(record, record);
  expectTypeOf(recoveredRecord.get("count")).toEqualTypeOf<Ref<number>>();

  const passthrough = subgraph("passthrough", (value: Ref<number>) => value);
  expectTypeOf(passthrough(number)).toEqualTypeOf<Ref<number>>();
  // @ts-expect-error Subgraph parameters retain their declared ref type.
  passthrough(text);

  const descriptor = {
    key: "tuple",
    program: "tool",
    operands: {
      kind: "positional",
      parts: [{ name: "source" }, { name: "targets", variadic: true }],
      separator: true,
    },
  } as const;

  const command = defineCommand(descriptor);

  expectTypeOf<CommandInput<typeof descriptor>["args"]>().toEqualTypeOf<
    readonly [string | Ref<string>, string | Ref<string>, ...(string | Ref<string>)[]]
  >();
  // @ts-expect-error A variadic target still requires its first operand.
  command({ args: ["source"] });

  const failed = branch(eq(number, 1), { yes: () => fail("yes"), no: () => fail("no") });
  // @ts-expect-error A never result cannot be authored as log data.
  log("failed", failed);
  // @ts-expect-error Refs have no runtime output property.
  void number.output;
  // @ts-expect-error Paths are private ref metadata.
  void number.path;

  const optional = defineCommand({ key: "null", program: "true" });
  expectTypeOf(optional()).toEqualTypeOf<Ref<null>>();
  expectTypeOf(code("effect", { in: {}, module: "./effect.ts" })).toEqualTypeOf<Ref<null>>();
  expectTypeOf(wait("signal")).toEqualTypeOf<Ref<null>>();
}

void operandTypes;

void schemaTypes;

void controlTypes;

test("parsed array outputs remain measurable", () => {
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
