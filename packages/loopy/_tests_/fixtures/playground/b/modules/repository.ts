import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Infer } from "../../../../../src/sdk/graph";

export type Input = Infer<{
  kind: "record";
  fields: { batch: "string"; ordinal: "number"; fail: "boolean"; items: "number[]" };
}>;

export interface Context {
  log(message: string, data?: Record<string, string | number | boolean>): void;
}

export const root = "loopies-playground";

export function readItems() {
  const source = readFileSync(`${root}/src/ci-values.txt`, "utf8").trim();

  return source === "" ? [] : source.split("\n").map(Number);
}

export function writeResult(input: Input, slug: string, values: number[], summary: string) {
  const artifactPath = `${root}/results/result.json`;
  mkdirSync(`${root}/results`, { recursive: true });
  const checksum = values.reduce((total, value) => total + value, 0);
  writeFileSync(
    artifactPath,
    `${JSON.stringify({ batch: input.batch, ordinal: input.ordinal, slug, summary, values, checksum })}\n`,
  );

  return { artifactPath, checksum, entries: values.length };
}
