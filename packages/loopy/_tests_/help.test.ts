import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { renderArgv } from "../src/core/index.js";
import { initialState, step } from "../src/engine/index.js";
import { parseCliHelp } from "../src/local/typegen/parse-help";
import { renderCommandSource } from "../src/local/typegen/render";
import { defineCommand, loopy } from "../src/sdk/index.js";

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
    expect(source.split("\n")[0]).toBe(
      'import { type CommandDescriptor, defineCommand } from "loopy";',
    );
    expect(source).toContain("as const satisfies CommandDescriptor");
    expect(source).toContain('"read-only"');
  });

  test("generated descriptors produce graph command dispatches", () => {
    const descriptor = parseCliHelp("codex", ["exec"], help).descriptor;
    const { parse, ...data } = descriptor;
    expect(parse).toBeUndefined();
    const codexExec = defineCommand(data);

    const graph = loopy("generated", {
      input: {},
      run: () => codexExec({ args: ["--help"] }),
    }).graph;

    expect(
      step(graph, initialState("generated", {}), {
        kind: "resume",
        at: new Date(0).toISOString(),
      }).next,
    ).toEqual(
      expect.objectContaining({
        kind: "dispatch",
        spec: expect.objectContaining({ argv: ["codex", "--help"] }),
      }),
    );
  });
  test("emitted source typechecks against the SDK with typed flags and arity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loopy-generated-"));
    const file = join(directory, "codex.ts");

    const source = renderCommandSource(
      "codexExec",
      parseCliHelp("codex", ["exec"], help).descriptor,
    );

    const gitHelp = await Bun.file(resolve(import.meta.dir, "fixtures/help/git-log.txt")).text();

    const gitSource = renderCommandSource(
      "gitLog",
      parseCliHelp("git", ["log"], gitHelp).descriptor,
    )
      .replace('import { type CommandDescriptor, defineCommand } from "loopy";', "")
      .replaceAll("descriptor", "logDescriptor");

    try {
      await writeFile(
        file,
        `${source}
      ${renderCommandSource(
        "noFlags",
        parseCliHelp(
          "tool",
          [],
          "Usage: tool [flags]\nOptions:\n  --help  Show help\n  --version  Show version",
        ).descriptor,
      )
        .replace('import { type CommandDescriptor, defineCommand } from "loopy";', "")
        .replaceAll("descriptor", "emptyDescriptor")}
      ${gitSource}
      gitLog({ args: ["HEAD"], flags: { oneline: true, maxCount: 1 } });
      gitLog({ revisions: ["HEAD"], paths: ["src"] });
      // @ts-expect-error Generated boolean flags retain their type.
      gitLog({ args: ["HEAD"], flags: { oneline: "yes" } });
      // @ts-expect-error Empty flag maps reject excess flags.
      noFlags({ flags: { typo: true } });
      codexExec({ args: ["hi"], flags: { json: true, config: ["model=test"] } });
      // @ts-expect-error Unknown flags must fail compilation.
      codexExec({ flags: { typo: true } });
      // @ts-expect-error Boolean flags retain their type.
      codexExec({ flags: { json: "true" } });
      // @ts-expect-error The descriptor declares at most one positional.
      codexExec({ args: ["one", "two"] });
      `,
      );

      const program = ts.createProgram([file], {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        types: ["bun-types"],
        paths: { loopy: [resolve(import.meta.dir, "../src/sdk/index.ts")] },
      });

      expect(
        ts
          .getPreEmitDiagnostics(program)
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
      style: "equals",
    });
    expect(() => renderCommandSource("default", parsed.descriptor)).toThrow(
      "valid TypeScript identifier",
    );
  });

  test("reads inline choices", () => {
    const parsed = parseCliHelp(
      "tool",
      [],
      "Usage: tool [OPTIONS] [NAME]\n\nOptions:\n  --mode <MODE>  Choose [possible values: safe, fast]\n",
    );

    expect(parsed.descriptor.flags?.mode?.choices).toEqual(["safe", "fast"]);
  });
});

for (const fixture of [
  {
    binary: "gh",
    path: ["pr", "create"],
    file: "gh-pr-create",
    positional: undefined,
    flag: "assignee",
    kind: "string",
    separator: false,
  },
  {
    binary: "git",
    path: ["log"],
    file: "git-log",
    positional: "revision-range",
    flag: "follow",
    kind: "boolean",
    separator: false,
  },
  {
    binary: "bun",
    path: ["build"],
    file: "bun-build",
    positional: "entrypoint",
    flag: "outfile",
    kind: "string",
    separator: false,
  },
  {
    binary: "jq",
    path: [],
    file: "jq",
    positional: "filter",
    flag: "rawOutput",
    kind: "boolean",
    separator: false,
  },
] as const) {
  test(`captured ${fixture.file} help preserves operands and flag metadata`, async () => {
    const help = await Bun.file(
      resolve(import.meta.dir, "fixtures/help", `${fixture.file}.txt`),
    ).text();

    const { descriptor } = parseCliHelp(fixture.binary, fixture.path, help);
    expect(descriptor.positionals?.[0]?.name).toBe(fixture.positional);
    expect(descriptor.flags?.[fixture.flag]?.kind).toBe(fixture.kind);
    expect(descriptor.positionalSeparator).toBe(fixture.separator);
    expect(descriptor.flags).not.toHaveProperty("help");
    expect(descriptor.flags).not.toHaveProperty("version");
    expect(
      descriptor.positionals?.some((positional) => /^(options|flags)$/.test(positional.name)),
    ).toBe(false);
    const source = renderCommandSource("generated", descriptor);
    expect(source).toContain(`${fixture.flag}: { cli: `);
    expect(source).not.toContain('"program":');

    if (fixture.binary === "git") {
      expect(descriptor.revisionPaths).toBe(true);
      expect(descriptor.positionals?.[1]).toMatchObject({
        name: "path",
        optional: true,
        variadic: true,
      });
    }
  });
}

test("man-page overstrikes retain the advertised positional separator", () => {
  const { descriptor } = parseCliHelp(
    "git",
    ["log"],
    "SYNOPSIS\n       g\bgit log [[-\b--\b-] <path>...]\nOPTIONS\n       --follow\n",
  );

  expect(descriptor.positionalSeparator).toBe(true);
  expect(descriptor.positionals).toEqual([{ name: "path", optional: true, variadic: true }]);
});

test("only path-only usage receives an automatic positional separator", () => {
  for (const operand of ["pathspec", "path", "file"]) {
    const { descriptor } = parseCliHelp(
      "tool",
      [],
      `Usage: tool [--] <${operand}>...\nOptions:\n  --json  JSON output`,
    );

    expect(descriptor.positionalSeparator).toBe(true);
  }

  const { descriptor } = parseCliHelp(
    "tool",
    [],
    "Usage: tool <name> [[--] <path>...]\nOptions:\n  --json  JSON output",
  );

  expect(descriptor.positionalSeparator).toBe(false);
  expect(descriptor.revisionPaths).toBe(false);
});

test("comma aliases retain value styles and repeatable placeholder metadata", () => {
  const { descriptor, warnings } = parseCliHelp(
    "git",
    ["log"],
    `Usage: git [-C <path>] log [<revision-range>] [[--] <path>...]
Options:
  -n, --max-count <number>  Limit commits
  -a, --author=<name>  Filter author
  -f, --files <files>  Select files
  -p, --pattern <pattern>...  Match patterns
  -l, --label <name>  Label (can be repeated)
  -r, --reviewer <handle>  Select multiple reviewers
`,
  );

  expect(warnings.some((warning) => warning.includes("Could not parse option"))).toBe(false);
  expect(descriptor.flags).toMatchObject({
    maxCount: { kind: "number" },
    author: { kind: "string", style: "equals" },
    files: { repeatable: true },
    pattern: { repeatable: true },
    label: { repeatable: true },
    reviewer: { repeatable: true },
  });
  expect(descriptor.positionals?.map((operand) => operand.name)).toEqual([
    "revision-range",
    "path",
  ]);
});

test("captured gh flags accept repeated labels, assignees and reviewers", async () => {
  const captured = await Bun.file(
    resolve(import.meta.dir, "fixtures/help/gh-pr-create.txt"),
  ).text();

  const { descriptor, warnings } = parseCliHelp("gh", ["pr", "create"], captured);
  expect(descriptor.flags).toMatchObject({
    assignee: { repeatable: true },
    label: { repeatable: true },
    reviewer: { repeatable: true },
  });
  expect(warnings.some((warning) => warning.includes("Could not parse option"))).toBe(false);
  expect(
    renderArgv(
      descriptor,
      { flags: { label: ["bug", "fix"], assignee: ["alice", "bob"], reviewer: ["carol", "dave"] } },
      "gh.pr.create",
    ),
  ).toEqual([
    "pr",
    "create",
    "--assignee",
    "alice",
    "--assignee",
    "bob",
    "--label",
    "bug",
    "--label",
    "fix",
    "--reviewer",
    "carol",
    "--reviewer",
    "dave",
  ]);
});
