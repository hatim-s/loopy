import { readFile } from "node:fs/promises";
import type { ParserInput } from "../../src";

export function result(stdout: string, exitCode = 0): ParserInput {
  return { stdout, stderr: "", exitCode };
}

export function fixture(namespace: string, name: string, platform = "darwin") {
  return readFile(new URL(`./shell/${namespace}/${name}.${platform}.txt`, import.meta.url), "utf8");
}
