import { expect, test } from "bun:test";
import {
  parseGrep,
  parseGrepCount,
  parseJq,
  parseSha256,
  parseUniqCount,
  parseWc,
} from "../src/sdk/shell/parse/text.js";
import { fixture, result } from "./shell-parse-fixture.js";

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
