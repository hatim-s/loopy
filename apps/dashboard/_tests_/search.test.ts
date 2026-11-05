import { expect, test } from "bun:test";
import { Schema } from "effect";
import { searchField } from "../src/lib/search.ts";

test("invalid URL fields fall back independently while valid filters survive", () => {
  const decode = Schema.decodeUnknownSync(
    Schema.Struct({
      text: searchField(Schema.String),
      page: searchField(Schema.Int),
      mode: searchField(Schema.Literals(["all", "failed"])),
    }),
  );

  expect(decode({ text: "needle", page: "invalid", mode: "missing", extra: true })).toEqual({
    text: "needle",
  });
  expect(decode({ text: "", page: 0, mode: "failed" })).toEqual({
    text: "",
    page: 0,
    mode: "failed",
  });
  expect(decode({})).toEqual({});
});
