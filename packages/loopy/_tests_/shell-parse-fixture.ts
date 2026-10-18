import { readFile } from "node:fs/promises";
import type { CommandResult } from "../src/sdk/index.js";

export function result(stdout: string, exitCode = 0): CommandResult {
  return { stdout, stderr: "", exitCode, durationMs: 0 };
}

export function fixture(namespace: string, name: string, platform = "darwin") {
  return readFile(
    new URL(`./fixtures/shell/${namespace}/${name}.${platform}.txt`, import.meta.url),
    "utf8",
  );
}
