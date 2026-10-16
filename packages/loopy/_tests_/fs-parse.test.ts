import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRunStore } from "../src/runtime/index.js";
import { fs, loopy } from "../src/sdk/index.js";
import { startLoopy } from "../src/sdk/run.js";
import {
  parseDf,
  parseDu,
  parseFind,
  parseLs,
  parseMktemp,
  parseRealpath,
  parseStat,
  parseTree,
  parseWhich,
} from "../src/sdk/shell/parse/fs.js";
import { fixture, result, SpawnExecutor } from "./shell-parse-fixture.js";

test("find and ls preserve NUL-delimited paths and list basenames", async () => {
  const paths = parseFind(result(await fixture("fs", "find")));
  expect(paths).toContain("./space name.txt");
  expect(parseLs(result(await fixture("fs", "ls")))).toEqual(
    expect.arrayContaining(["words.txt", "space name.txt", "nested", "link"]),
  );
  expect(parseFind(result("a\nb\0tab\té\0"))).toEqual(["a\nb", "tab\té"]);
  expect(parseFind(result(""))).toEqual([]);
});

for (const platform of ["darwin", "linux"]) {
  test(`stat normalizes file metadata (${platform})`, async () => {
    const entries = parseStat(result(await fixture("fs", "stat", platform)));
    expect(entries.map(({ type }) => type)).toEqual(["file", "file", "directory", "symlink"]);
    expect(entries[0]).toEqual({
      path: "words.txt",
      size: 28,
      mtime: "2023-11-14T22:13:20.000Z",
      type: "file",
      mode: "644",
    });
  });
  test(`df parses portable kilobytes (${platform})`, async () => {
    expect(parseDf(result(await fixture("fs", "df", platform)))[0]).toEqual({
      filesystem: expect.any(String),
      kilobytes: expect.any(Number),
      used: expect.any(Number),
      available: expect.any(Number),
      capacity: expect.any(Number),
      mountedOn: expect.stringMatching(/^\//),
    });
  });
}

test("du, realpath, which, mktemp and tree parse real captures", async () => {
  expect(parseDu(result(await fixture("fs", "du")))).toEqual([
    { path: ".", kilobytes: expect.any(Number) },
  ]);
  expect(parseRealpath(result(await fixture("fs", "realpath")))).toEndWith("/words.txt");
  expect(parseWhich(result(await fixture("fs", "which")))).toEndWith("/bun");
  expect(parseWhich(result("", 1))).toBeNull();
  expect(parseMktemp(result(await fixture("fs", "mktemp")))).toContain("/created.");
  expect(parseTree(result(await fixture("fs", "tree")))[0]).toMatchObject({
    type: "directory",
    name: ".",
    contents: expect.arrayContaining([{ type: "file", name: "link" }]),
  });
});

test.each([
  ["find", parseFind],
  ["ls", parseLs],
  ["stat", parseStat],
  ["du", parseDu],
  ["df", parseDf],
  ["tree", parseTree],
] as const)("%s rejects invalid output with the offending line", (command, parse) => {
  expect(() => parse(result("invalid"))).toThrow(
    `Unexpected ${command} output line: invalid. Report this with the ${command} version.`,
  );
});

async function filesystemRun(cwd: string) {
  return startLoopy({
    loopy: loopy({
      name: "fs-parsed",
      run: async () => ({
        find: await fs.find({ args: ["."], flags: { type: "f" } }),
        ls: await fs.ls(),
        realpath: await fs.realpath({ args: ["words.txt"] }),
        stat: await fs.stat({ args: ["words.txt"] }),
        du: await fs.du({ args: ["."], flags: { summary: true } }),
        missing: await fs.which({ args: ["loopy-command-that-does-not-exist-6b"] }),
      }),
    }),
    store: new MemoryRunStore(),
    executor: new SpawnExecutor(),
    workspace: cwd,
    runId: "fs-parsed",
    input: {},
    bundleHash: "",
  });
}

test("real filesystem commands persist typed results and which-not-found succeeds", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loopy-fs-parse-"));

  try {
    await writeFile(join(cwd, "words.txt"), "hello\n");
    expect(await filesystemRun(cwd)).toMatchObject({
      status: "succeeded",
      output: {
        find: ["./words.txt"],
        ls: ["words.txt"],
        realpath: await realpath(join(cwd, "words.txt")),
        missing: null,
        stat: [{ path: "words.txt", size: 6, type: "file", mode: "644" }],
        du: [{ path: ".", kilobytes: expect.any(Number) }],
      },
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function compileOnlyChecks() {
  // @ts-expect-error Deletion has no parsed output.
  fs.find({ flags: { delete: true } });
  fs.find.raw({ flags: { delete: true } });
  // @ts-expect-error Parsed ls always returns immediate basenames.
  fs.ls({ flags: { l: true } });
  fs.ls.raw({ flags: { l: true } });
  // @ts-expect-error Human-readable units change the du format.
  fs.du({ flags: { humanReadable: true } });
  fs.du.raw({ flags: { humanReadable: true } });
}

void compileOnlyChecks;

test("stat preserves captured newlines and metadata separators inside filenames", async () => {
  expect(parseStat(result(await fixture("fs", "stat-paths")))).toEqual([
    {
      path: "line\nbreak.txt",
      size: 6,
      mtime: "2023-11-14T22:13:20.000Z",
      type: "file",
      mode: "644",
    },
    {
      path: "separator\x01name.txt",
      size: 6,
      mtime: "2023-11-14T22:13:20.000Z",
      type: "file",
      mode: "644",
    },
  ]);
});

test("stat accepts unpadded octal permissions and du preserves leading path whitespace", () => {
  expect(parseStat(result("empty\x010\x010\x01regular empty file\x010\n"))).toEqual([
    { path: "empty", size: 0, mtime: "1970-01-01T00:00:00.000Z", type: "file", mode: "0" },
  ]);
  expect(parseDu(result("4\t  leading space\n"))).toEqual([
    { path: "  leading space", kilobytes: 4 },
  ]);
});
