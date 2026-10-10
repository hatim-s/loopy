import { expect, test } from "bun:test";
import { parseCliArgs } from "../src/cli/args.ts";

test("named input preserves strings, equals signs, empty values, and own properties", () => {
  const parsed = parseCliArgs([
    "run",
    "example",
    "--message",
    "hello world",
    "--code=001",
    "--empty=",
    "--negative",
    "-2",
    "--dash=--text",
    "--__proto__=safe",
    "--url=a=b",
  ]);

  expect(parsed.triggerInput).toEqual(
    JSON.parse(
      '{"message":"hello world","code":"001","empty":"","negative":"-2","dash":"--text","__proto__":"safe","url":"a=b"}',
    ),
  );
});

test("reserved options stay separate and separator allows colliding input keys", () => {
  const parsed = parseCliArgs([
    "--home",
    "/tmp/run",
    "run",
    "x",
    "--full",
    "--",
    "--full",
    "false",
    "--input",
    "text",
  ]);

  expect(parsed.values.full).toBe(true);
  expect(parsed.triggerInput).toEqual({ full: "false", input: "text" });
  expect(parseCliArgs(["types", "tool", "--", "--help"]).positionals).toEqual([
    "types",
    "tool",
    "--help",
  ]);
});

test("ambiguous or incomplete inputs fail before execution", () => {
  for (const args of [
    ["run", "x", "--key"],
    ["run", "x", "--key", "--full"],
    ["run", "x", "--key=a", "--key=b"],
    ["run", "x", "--args", "a.json", "--input", "{}"],
    ["run", "x", "--input", "{}", "--key=a"],
    ["resume", "id", "--args", "a.json"],
    ["list", "--typo", "x"],
  ]) {
    expect(() => parseCliArgs(args)).toThrow();
  }
});
