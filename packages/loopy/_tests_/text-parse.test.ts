import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRunStore } from "../src/runtime/index.js";
import { loopy, text } from "../src/sdk/index.js";
import {
  parseGrep,
  parseGrepCount,
  parseJq,
  parseSha256,
  parseUniqCount,
  parseWc,
} from "../src/sdk/shell/parse/text.js";
import { startLoopy } from "./fixture.js";
import { fixture, result, SpawnExecutor } from "./shell-parse-fixture.js";

test("wc drops only the aggregate row for multiple file operands", async () => {
  expect(
    parseWc(result(await fixture("text", "wc")), { args: ["words.txt", "space name.txt"] }),
  ).toEqual([
    { lines: 3, words: 5, bytes: 28, file: "words.txt" },
    { lines: 1, words: 1, bytes: 7, file: "space name.txt" },
  ]);
  expect(parseWc(result(" 0 0 0\n"))).toEqual([{ lines: 0, words: 0, bytes: 0 }]);
  expect(parseWc(result(" 1 2 3 total\n"), { args: ["total"] })).toEqual([
    { lines: 1, words: 2, bytes: 3, file: "total" },
  ]);
  expect(
    parseWc(result(" 1 2 3 total\n 4 5 6 other\n 5 7 9 total\n"), { args: ["total", "other"] }),
  ).toEqual([
    { lines: 1, words: 2, bytes: 3, file: "total" },
    { lines: 4, words: 5, bytes: 6, file: "other" },
  ]);
});

test("uniqCount preserves whitespace", async () => {
  expect(parseUniqCount(result(await fixture("text", "uniq-count")))).toEqual([
    { count: 2, line: "hello world" },
    { count: 1, line: "bye" },
  ]);
  expect(parseUniqCount(result("  2  indented\n  1 \n"))).toEqual([
    { count: 2, line: " indented" },
    { count: 1, line: "" },
  ]);
});

test("grep separates text matches from binary filenames", async () => {
  expect(parseGrep(result(await fixture("text", "grep")))).toEqual({
    matches: [
      { file: null, line: 1, text: "hello world" },
      { file: null, line: 2, text: "hello world" },
    ],
    binaryMatches: [],
  });
  expect(parseGrep(result(await fixture("text", "grep-files"))).matches).toContainEqual({
    file: "space name.txt",
    line: 1,
    text: "second",
  });
  expect(parseGrep(result("12:text:34:more\nBinary file space name.bin matches\n"))).toEqual({
    matches: [{ file: null, line: 12, text: "text:34:more" }],
    binaryMatches: ["space name.bin"],
  });
  expect(parseGrep(result("", 1))).toEqual({ matches: [], binaryMatches: [] });
  expect(parseGrepCount(result(await fixture("text", "grep-count")))).toBe(2);
  expect(parseGrepCount(result("0\n", 1))).toBe(0);
});

for (const platform of ["darwin", "linux"]) {
  test(`sha256 parses hashes and filenames (${platform})`, async () => {
    const entries = parseSha256(result(await fixture("text", "sha256", platform)));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      hash: Bun.CryptoHasher.hash("sha256", "hello world\nhello world\nbye\n", "hex"),
      file: "words.txt",
    });
    expect(entries[1]?.file).toBe("space name.txt");
  });
}

test("checksum escaping and jq JSON streams retain their values", async () => {
  expect(parseSha256(result(`\\${"a".repeat(64)}  line\\nbreak\\\\file\n`))).toEqual([
    { hash: "a".repeat(64), file: "line\nbreak\\file" },
  ]);
  expect(parseJq(result(await fixture("text", "jq")))).toEqual([{ n: 1 }, { n: 2 }]);
  expect(parseJq(result('"text"\n'))).toBe("text");
  expect(parseJq(result("null\n"))).toBeNull();
  expect(parseJq(result("[1,2]\n"))).toEqual([1, 2]);
  expect(parseJq(result(""))).toEqual([]);
});

test.each([
  ["wc", parseWc],
  ["uniq", parseUniqCount],
  ["grep", parseGrep],
  ["grep", parseGrepCount],
  ["sha256sum", parseSha256],
  ["jq", parseJq],
] as const)("%s rejects malformed output with the offending line", (command, parse) => {
  expect(() => parse(result("invalid"))).toThrow(
    `Unexpected ${command} output line: invalid. Report this with the ${command} version.`,
  );
});

async function textRun(cwd: string) {
  return startLoopy({
    loopy: loopy({
      name: "text-parsed",
      run: async () => ({
        wc: await text.wc({ args: ["words.txt"] }),
        totalFile: await text.wc({ args: ["total"] }),
        totals: await text.wc({ args: ["total", "other.txt"] }),
        binary: await text.grep({ args: ["hello", "binary.bin"] }),
        uniq: await text.uniqCount({ args: ["words.txt"] }),
        grep: await text.grep({ args: ["hello", "words.txt"] }),
        files: await text.grep({ args: ["hello", "words.txt", "other.txt"] }),
        missing: await text.grep({ args: ["absent", "words.txt"] }),
        count: await text.grepCount({ args: ["absent", "words.txt"] }),
        sha: await text.sha256sum({ args: ["words.txt"] }),
        jq: await text.jq({ args: [".[]", "data.json"] }),
      }),
    }),
    executor: new SpawnExecutor(),
    store: new MemoryRunStore(),
    workspace: cwd,
    runId: "text-parsed",
    input: {},
    bundleHash: "",
  });
}

const TEXT_OUTPUT = {
  wc: [{ lines: 3, words: 5, bytes: 28, file: "words.txt" }],
  uniq: [
    { count: 2, line: "hello world" },
    { count: 1, line: "bye" },
  ],
  totalFile: [{ lines: 1, words: 1, bytes: 6, file: "total" }],
  totals: [
    { lines: 1, words: 1, bytes: 6, file: "total" },
    { lines: 1, words: 1, bytes: 6, file: "other.txt" },
  ],
  grep: {
    matches: [
      { file: null, line: 1, text: "hello world" },
      { file: null, line: 2, text: "hello world" },
    ],
    binaryMatches: [],
  },
  binary: { matches: [], binaryMatches: ["binary.bin"] },
  missing: { matches: [], binaryMatches: [] },
  count: 0,
  files: {
    matches: expect.arrayContaining([{ file: "other.txt", line: 1, text: "hello" }]),
    binaryMatches: [],
  },
  sha: [{ hash: expect.stringMatching(/^[a-f0-9]{64}$/), file: "words.txt" }],
  jq: [{ n: 1 }, { n: 2 }],
};

test("real text tools persist parsed outputs and grep-no-match succeeds", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loopy-text-parse-"));

  try {
    await writeFile(join(cwd, "words.txt"), "hello world\nhello world\nbye\n");
    await writeFile(join(cwd, "other.txt"), "hello\n");
    await writeFile(join(cwd, "total"), "hello\n");
    await writeFile(join(cwd, "binary.bin"), "hello\0world\n");
    await writeFile(join(cwd, "data.json"), '[{"n":1},{"n":2}]');
    expect(await textRun(cwd)).toMatchObject({ status: "succeeded", output: TEXT_OUTPUT });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function compileOnlyChecks() {
  // @ts-expect-error Count-only output does not contain lines.
  text.grep({ flags: { c: true } });
  text.grep.raw({ flags: { c: true } });
  // @ts-expect-error Parsed wc requires all three counts.
  text.wc({ flags: { bytes: true } });
  text.wc.raw({ flags: { bytes: true } });
  // @ts-expect-error Raw jq strings are not JSON.
  text.jq({ flags: { rawOutput: true } });
  text.jq.raw({ flags: { rawOutput: true } });
}

void compileOnlyChecks;
