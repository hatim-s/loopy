import { expect, test } from "bun:test";
import { z } from "zod";
import { parseCliArgs } from "../src/cli/args.ts";
import { errorMessage } from "../src/core/index.js";

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

  expect(parsed.namedInput).toEqual(
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
    "--cwd",
    "/tmp/work",
    "--",
    "--full",
    "false",
    "--input",
    "text",
  ]);

  expect(parsed.values.cwd).toBe("/tmp/work");
  expect(parsed.namedInput).toEqual({ full: "false", input: "text" });
  expect(parseCliArgs(["types", "tool", "--out", "tool.ts", "--", "--help"]).positionals).toEqual([
    "types",
    "tool",
    "--help",
  ]);
});

test("ambiguous or incomplete inputs fail before execution", () => {
  for (const { args, reason } of [
    { args: ["run", "x", "--key"], reason: "Loopy input --key requires a value" },
    { args: ["run", "x", "--key", "--full"], reason: "Loopy input --key requires a value" },
    {
      args: ["run", "x", "--key=a", "--key=b"],
      reason: "Loopy input --key was provided more than once",
    },
    {
      args: ["run", "x", "--input-file", "a.json", "--input-json", "{}"],
      reason: "Choose one input source",
    },
    { args: ["run", "x", "--input-json", "{}", "--key=a"], reason: "Choose one input source" },
    { args: ["resume", "id", "--args", "a.json"], reason: "Unknown option '--args'" },
    { args: ["list", "--typo", "x"], reason: "Unknown option '--typo'" },
    {
      args: ["graph", "x", "--format", "svg"],
      reason: 'Invalid option: expected one of "json"|"text"',
    },
    {
      args: ["daemon", "run", "--lease-ms", "999"],
      reason: "Too small: expected number to be >=1000",
    },
    {
      args: ["daemon", "run", "--concurrency", "0"],
      reason: "Too small: expected number to be >=1",
    },
    {
      args: ["daemon", "run", "--port", "65536"],
      reason: "Too big: expected number to be <=65535",
    },
    { args: ["schedule", "x", "--disable"], reason: "Unknown option '--disable'" },
    {
      args: ["schedule", "x", "disable", "--cron", "* * * * *"],
      reason: "Only schedule set accepts cron, timezone and input",
    },
    {
      args: ["schedule", "x", "restart"],
      reason: 'Invalid option: expected one of "set"|"enable"|"disable"|"off"',
    },
  ]) {
    let failure: unknown;

    try {
      parseCliArgs(args);
    } catch (error) {
      failure = error;
    }

    const message =
      failure instanceof z.ZodError
        ? failure.issues.map((issue) => issue.message).join("\n")
        : errorMessage(failure);

    expect(message).toContain(reason);
  }
});

test("command schemas produce numeric options and positional schedule actions", () => {
  expect(
    parseCliArgs(["daemon", "run", "--port", "0", "--concurrency", "2", "--lease-ms", "1000"])
      .values,
  ).toMatchObject({ port: 0, concurrency: 2, "lease-ms": 1000 });
  expect(parseCliArgs(["daemon", "run"]).values).toMatchObject({ port: 4310, concurrency: 4 });
  expect(parseCliArgs(["schedule", "x", "disable"]).values.action).toBe("disable");
  expect(parseCliArgs(["schedule", "x"]).values.action).toBe("set");
});
