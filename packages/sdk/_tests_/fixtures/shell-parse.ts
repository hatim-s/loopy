import { readFile } from "node:fs/promises";
import type { CommandResult } from "../../src";

export function result(stdout: string, exitCode = 0): CommandResult {
  return { stdout, stderr: "", exitCode, durationMs: 0 };
}

export function fixture(namespace: string, name: string, platform = "darwin") {
  return readFile(new URL(`./shell/${namespace}/${name}.${platform}.txt`, import.meta.url), "utf8");
}
