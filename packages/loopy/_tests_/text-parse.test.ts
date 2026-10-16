import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRunStore } from "../src/runtime/index.js";
import { loopy, text } from "../src/sdk/index.js";
import { startLoopy } from "../src/sdk/run.js";
import {
  parseGrep,
  parseGrepCount,
  parseJq,
  parseSha256,
  parseUniqCount,
  parseWc,
} from "../src/sdk/shell/parse/text.js";
import { fixture, result, SpawnExecutor } from "./shell-parse-fixture.js";

test("wc drops totals, uniqCount preserves whitespace and grep parses both filename modes", async () => {
  expect(parseWc(result(await fixture("text", "wc")))).toEqual([
    { lines: 3, words: 5, bytes: 28, file: "words.txt" },
    { lines: 1, words: 1, bytes: 7, file: "space name.txt" },
  ]);
  expect(parseWc(result(" 0 0 0\n"))).toEqual([{ lines: 0, words: 0, bytes: 0 }]);
  expect(parseUniqCount(result(await fixture("text", "uniq-count")))).toEqual([
    { count: 2, line: "hello world" },
    { count: 1, line: "bye" },
  ]);
  expect(parseUniqCount(result("  2  indented\n  1 \n"))).toEqual([
    { count: 2, line: " indented" },
    { count: 1, line: "" },
  ]);
  expect(parseGrep(result(await fixture("text", "grep")))).toEqual([
    { file: null, line: 1, text: "hello world" },
    { file: null, line: 2, text: "hello world" },
  ]);
  expect(parseGrep(result(await fixture("text", "grep-files")))).toContainEqual({
    file: "space name.txt",
    line: 1,
    text: "second",
  });
  expect(parseGrep(result("12:text:34:more\n"))).toEqual([
    { file: null, line: 12, text: "text:34:more" },
  ]);
  expect(parseGrep(result("", 1))).toEqual([]);
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
    cwd,
    runId: "text-parsed",
    input: {},
    bundleHash: "",
  });
}

test("real text tools persist parsed outputs and grep-no-match succeeds", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loopy-text-parse-"));

  try {
    await writeFile(join(cwd, "words.txt"), "hello world\nhello world\nbye\n");
    await writeFile(join(cwd, "other.txt"), "hello\n");
    await writeFile(join(cwd, "data.json"), '[{"n":1},{"n":2}]');
    expect(await textRun(cwd)).toMatchObject({
      status: "succeeded",
      output: {
        wc: [{ lines: 3, words: 5, bytes: 28, file: "words.txt" }],
        uniq: [
          { count: 2, line: "hello world" },
          { count: 1, line: "bye" },
        ],
        grep: [
          { file: null, line: 1, text: "hello world" },
          { file: null, line: 2, text: "hello world" },
        ],
        missing: [],
        count: 0,
        files: expect.arrayContaining([{ file: "other.txt", line: 1, text: "hello" }]),
        sha: [{ hash: expect.stringMatching(/^[a-f0-9]{64}$/), file: "words.txt" }],
        jq: [{ n: 1 }, { n: 2 }],
      },
    });
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
