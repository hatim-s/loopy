import { readFile } from "node:fs/promises";
import type { RawCommandOutput } from "../src/sdk/index.js";

export function result(stdout: string, exitCode = 0): RawCommandOutput {
  return { stdout, stderr: "", exitCode };
}

export function fixture(namespace: string, name: string, platform = "darwin") {
  return readFile(
    new URL(`./fixtures/shell/${namespace}/${name}.${platform}.txt`, import.meta.url),
    "utf8",
  );
}
