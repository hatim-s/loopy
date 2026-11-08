import { expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeOptions } from "../src/command";
import { daemonCommand } from "../src/entry";
import { parseCommandLine } from "../src/parse";
import { COMMANDS } from "../src/table";

function parse(args: string[]) {
  const parsed = Effect.runSync(parseCommandLine(COMMANDS, args));

  if (parsed.kind !== "command") {
    throw new Error(`Expected a command for ${args.join(" ")}.`);
  }

  return parsed;
}

function failure(args: string[]) {
  return Effect.runSync(Effect.flip(parseCommandLine(COMMANDS, args))).message;
}

test("named input preserves strings, equals signs, empty values, and own properties", () => {
  const parsed = parse([
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

  expect(parsed.arguments.positionals).toEqual(["example"]);
  expect(parsed.arguments.namedInput).toEqual(
    JSON.parse(
      '{"message":"hello world","code":"001","empty":"","negative":"-2","dash":"--text","__proto__":"safe","url":"a=b"}',
    ),
  );
});

test("global and command options may precede the command and -- allows colliding input keys", () => {
  const parsed = parse([
    "--home",
    "/tmp/run",
    "--lease-ms",
    "2000",
    "daemon",
    "run",
    "--port",
    "0",
  ]);

  expect(parsed.command.path).toEqual(["daemon", "run"]);
  expect(parsed.globals.home).toBe("/tmp/run");
  expect(parsed.arguments.values.get("lease-ms")).toBe("2000");
  expect(
    parse(["run", "x", "--", "--full", "false", "--input", "text"]).arguments.namedInput,
  ).toEqual({ full: "false", input: "text" });
  expect(parse(["types", "tool", "--", "--help"]).arguments.positionals).toEqual([
    "tool",
    "--help",
  ]);
});

test("help and a bare invocation print usage instead of running", () => {
  expect(Effect.runSync(parseCommandLine(COMMANDS, []))).toMatchObject({ kind: "usage" });
  expect(Effect.runSync(parseCommandLine(COMMANDS, ["logs", "-h"]))).toMatchObject({
    kind: "usage",
    command: { path: ["logs"] },
  });
  expect(parse(["run", "x", "--key", "-h"]).arguments.namedInput).toEqual({ key: "-h" });
});

test("ambiguous, incomplete or unknown arguments fail before execution", () => {
  for (const [args, message] of [
    [["run", "x", "--key"], "Loopy input --key requires a value."],
    [["run", "x", "--key", "--full"], "Loopy input --key requires a value."],
    [["run", "x", "--key=a", "--key=b"], "Loopy input --key was provided more than once."],
    [["run", "x", "--", "value"], "Expected a loopy input flag, received 'value'."],
    [["resume", "id", "--args", "a.json"], "Unknown option '--args' for loopy resume."],
    [["list", "--typo", "x"], "Unknown option '--typo' for loopy list."],
    [["run", "x", "-k"], "Unknown option '-k' for loopy run."],
    [["graph", "x", "--format"], "Option --format requires a value."],
    [["logs", "id", "--follow=yes"], "Option --follow does not take a value."],
    [["deploy"], "Unknown command 'deploy'. Run loopy --help."],
    [["daemon"], "Choose a daemon action. Use loopy daemon run, install, uninstall or status."],
    [
      ["secrets", "rotate"],
      "Unknown secrets action 'rotate'. Use loopy secrets set, list or remove.",
    ],
  ] as const) {
    expect(failure([...args])).toStartWith(message);
  }
});

test("the service argv the CLI installs parses back to daemon run with the same flags", async () => {
  const [, , ...args] = daemonCommand({
    home: "/data/loopy",
    port: 4999,
    concurrency: 7,
    leaseMs: 5000,
  });

  const parsed = await Effect.runPromise(parseCommandLine(COMMANDS, args));

  if (parsed.kind !== "command") {
    throw new Error("The daemon argv must name a command.");
  }

  expect(parsed.command.path).toEqual(["daemon", "run"]);
  expect(parsed.globals.home).toBe("/data/loopy");
  expect(await Effect.runPromise(decodeOptions(parsed.command.options, parsed.arguments))).toEqual({
    port: 4999,
    concurrency: 7,
    "lease-ms": 5000,
  });
});
