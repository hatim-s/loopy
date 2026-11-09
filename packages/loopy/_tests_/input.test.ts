import { expect, test } from "bun:test";
import { FIELD_TYPES, type FieldType, type Json, parseFieldText, recordFields } from "@loopy/core";

const samples: [FieldType, Json][] = [
  ["string", "hello"],
  ["number", 2],
  ["boolean", true],
  ["json", { nested: [null, true] }],
  ["string[]", ["a", "b"]],
  ["number[]", [1, 2]],
  ["boolean[]", [true, false]],
  ["json[]", [null, 1, "a", { nested: [] }]],
];

test("field text parses to the value of every field type", () => {
  expect(samples.map(([kind]) => kind)).toEqual([...FIELD_TYPES]);

  for (const [kind, value] of samples) {
    const text = kind === "string" ? String(value) : JSON.stringify(value);

    expect(parseFieldText(kind, text)).toEqual({ ok: true, value });
  }
});

test("field text rejects malformed JSON, wrong kinds and loose scalars", () => {
  expect(parseFieldText("json", "{bad")).toEqual({ ok: false, reason: "json" });
  // JSON.parse reads these as Infinity, which would be stored as null.
  expect(parseFieldText("json", "1e400")).toEqual({ ok: false, reason: "json" });
  expect(parseFieldText("json[]", "[1e400]")).toEqual({ ok: false, reason: "json" });

  for (const [kind, text] of [
    ["string[]", "[1]"],
    ["number[]", '["1"]'],
    ["boolean[]", '["true"]'],
    ["json[]", "{}"],
    ["number", " "],
    ["number", "12abc"],
    ["boolean", "yes"],
  ] as const) {
    expect(parseFieldText(kind, text)).toEqual({ ok: false, reason: "kind" });
  }
});

test("a trailing ? marks a record field optional and drops from its key", () => {
  expect(recordFields({ name: "string", "count?": "number" })).toEqual([
    { key: "name", optional: false, kind: "string" },
    { key: "count", optional: true, kind: "number" },
  ]);
});
