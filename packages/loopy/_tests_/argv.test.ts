import { describe, expect, test } from "bun:test";
import { parseArgv } from "../src/core/index.js";

describe("parseArgv", () => {
  test("splits whitespace and preserves literal words without expansion", () => {
    expect(parseArgv(" \tgit log\n--oneline *.ts $HOME ")).toEqual([
      "git",
      "log",
      "--oneline",
      "*.ts",
      "$HOME",
    ]);
    expect(parseArgv(" \n ")).toEqual([]);
  });
  test("joins quotes, preserves empty words and single-quoted literals", () => {
    expect(parseArgv(`a' b'"c" '' "" 'a\\b|$()'`)).toEqual(["a bc", "", "", "a\\b|$()"]);
  });
  test("escapes outside quotes and only quotes and backslashes inside double quotes", () => {
    expect(parseArgv('a\\ b \\| \\$\\( \\` "a\\"b\\\\c\\qd"')).toEqual([
      "a b",
      "|",
      "$(",
      "`",
      'a"b\\c\\qd',
    ]);
    expect(parseArgv('"| > < ; & $( `"')).toEqual(["| > < ; & $( `"]);
  });
  test.each(["|", ">", "<", ";", "&", "$(", "`"])("rejects unquoted %s", (token) => {
    expect(() => parseArgv(`echo x${token}y`)).toThrow(
      `Unsupported shell character '${token}'. Pass stdin or use separate commands instead.`,
    );
  });
  test.each(["'", '"'])("rejects an unterminated %s quote", (quote) => {
    expect(() => parseArgv(`echo ${quote}abc`)).toThrow(
      `Unterminated ${quote} quote. Close the quote before running the command.`,
    );
  });
  test("rejects a trailing escape", () => {
    expect(() => parseArgv("echo \\")).toThrow(
      "Trailing backslash in command. Add an escaped character or remove the backslash.",
    );
  });
});
