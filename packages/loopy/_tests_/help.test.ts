import { describe, expect, test } from "bun:test";
import { defineCommand } from "../src/core/command";
import { parseCliHelp, renderCommandSource } from "../src/local/help";

const help = `Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]

Arguments:
  [PROMPT]  Initial instructions

Options:
  -m, --model <MODEL>  Model the agent should use
  -s, --sandbox <SANDBOX_MODE>  Select the sandbox policy
          [possible values: read-only, workspace-write, danger-full-access]
      --json  Print events as JSONL
  -c, --config <key=value>  Override configuration (repeatable)
`;

describe("CLI help generation", () => {
  test("extracts positional and flag types with a pinned help hash", () => {
    const parsed = parseCliHelp("codex", ["exec"], help);
    expect(parsed.warnings).toContain(
      "Help may omit which valued flags can repeat; review repeatable flag metadata",
    );
    expect(parsed.descriptor.positionals).toEqual([{ name: "prompt", optional: true }]);
    expect(parsed.descriptor.flags).toMatchObject({
      model: { cli: "--model", kind: "string" },
      sandbox: {
        cli: "--sandbox",
        kind: "string",
        choices: ["read-only", "workspace-write", "danger-full-access"],
      },
      json: { cli: "--json", kind: "boolean" },
      config: { cli: "--config", kind: "string", repeatable: true },
    });
    expect(parsed.descriptor.helpHash).toHaveLength(64);
    const source = renderCommandSource("codexExec", parsed.descriptor);
    expect(source).toContain("as const satisfies CommandDescriptor");
    expect(source).toContain('"read-only"');
  });

  test("rejects unknown flags when constructing argv", () => {
    const parsed = parseCliHelp("codex", ["exec"], help);
    const codexExec = defineCommand(parsed.descriptor);
    expect(codexExec({ args: [] }).args).toEqual(["exec"]);
    expect(codexExec({ args: ["hi"], flags: { json: true, model: "gpt" } } as never).args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt",
      "--",
      "hi",
    ]);
    const literal = codexExec({ args: ["--help"], flags: { sandbox: "read-only" } } as never);
    expect(literal.args).toEqual(["exec", "--sandbox", "read-only", "--", "--help"]);
    expect(literal.argConstraints).toEqual({
      2: { kind: "string", choices: ["read-only", "workspace-write", "danger-full-access"] },
      4: { kind: "string" },
    });
    expect(() => codexExec({ args: [], flags: { typo: true } as never })).toThrow("Unknown flag");
  });

  test("reports option lines it cannot parse", () => {
    const parsed = parseCliHelp(
      "tool",
      [],
      "Usage: tool [OPTIONS]\n\nOptions:\n  --bad=<strange token>\n",
    );
    expect(parsed.warnings.some((warning) => warning.includes("Could not parse option"))).toBe(
      true,
    );
  });

  test("reads a single line Usage synopsis when there is no Arguments section", () => {
    const parsed = parseCliHelp(
      "tool",
      ["run"],
      "Usage: tool run [OPTIONS] <FILE> [LABEL]\n\nOptions:\n  --json\n",
    );
    expect(parsed.descriptor.positionals).toEqual([
      { name: "file", optional: false },
      { name: "label", optional: true },
    ]);
  });

  test("reads bracketed, lowercase, and variadic positional syntax", () => {
    const parsed = parseCliHelp(
      "tool",
      [],
      "Usage: tool [OPTIONS] [<file>...]\n\nOptions:\n  --help  Show help\n",
    );
    expect(parsed.descriptor.positionals).toEqual([
      { name: "file", optional: true, variadic: true },
    ]);
  });

  test("models flags with optional values and rejects reserved export names", () => {
    const parsed = parseCliHelp(
      "tool",
      [],
      "Usage: tool [OPTIONS]\n\nOptions:\n  --inspect[=<PORT>]  Inspect a process\n",
    );
    expect(parsed.descriptor.flags?.inspect).toMatchObject({
      cli: "--inspect",
      kind: "number",
      optionalValue: true,
      attachedValue: true,
    });
    expect(() => renderCommandSource("default", parsed.descriptor)).toThrow(
      "valid TypeScript identifier",
    );
    const inspect = defineCommand({
      program: "tool",
      positionals: [],
      flags: { inspect: { cli: "--inspect", kind: "number", optionalValue: true } },
    });
    expect(inspect({ flags: { inspect: true } }).args).toEqual(["--inspect"]);
    expect(inspect({ flags: { inspect: 9229 } }).args).toEqual(["--inspect", 9229]);
    const attached = defineCommand(parsed.descriptor)({ flags: { inspect: 9229 } } as never);
    expect(attached.args).toEqual([{ $op: "concat", args: ["--inspect=", 9229] }]);
    expect(attached.argConstraints).toEqual({ 0: { kind: "number", prefix: "--inspect=" } });
    expect(() =>
      defineCommand({
        program: "tool",
        positionals: [{ name: "first", optional: true }, { name: "second" }],
      }),
    ).toThrow("required positional cannot follow an optional");
  });

  test("reads inline choices and permits tools without a positional separator", () => {
    const parsed = parseCliHelp(
      "tool",
      [],
      "Usage: tool [OPTIONS] [NAME]\n\nOptions:\n  --mode <MODE>  Choose [possible values: safe, fast]\n",
    );
    expect(parsed.descriptor.flags?.mode?.choices).toEqual(["safe", "fast"]);
    const echo = defineCommand({
      program: "echo",
      positionals: [{ name: "message" }],
      positionalSeparator: false,
    });
    expect(echo({ args: ["hello"] }).args).toEqual(["hello"]);
    const two = defineCommand({
      program: "tool",
      positionals: [
        { name: "first", optional: true },
        { name: "second", optional: true },
      ],
    });
    expect(() => two({ args: [undefined, "second"] })).toThrow(
      "Cannot omit a positional before a later positional",
    );
  });
});
