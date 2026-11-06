import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Infer } from "../../../../../src/sdk/graph";

export type PlaygroundInput = Infer<{
  kind: "record";
  fields: { batch: "string"; ordinal: "number"; fail: "boolean"; items: "number[]" };
}>;

export const repository = "loopies-playground";

export const sourceFiles = ["README.md", "data/records.csv", "docs/policy.md", "src/limits.ts"];

export function digest(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

export function readSource(file: string) {
  return readFile(`${repository}/${file}`, "utf8");
}

export async function writeResult(
  input: PlaygroundInput,
  slug: string,
  details: Record<string, string | number | boolean | string[]>,
) {
  const result = {
    batch: input.batch,
    ordinal: input.ordinal,
    slug,
    outcome: input.fail ? "failed" : "succeeded",
    ...details,
  };

  await mkdir(`${repository}/results`, { recursive: true });
  await writeFile(`${repository}/results/result.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Exported ${slug} result for ordinal ${input.ordinal}.`);

  if (input.fail) {
    throw new Error("PLAYGROUND_CONTROLLED_FAILURE: requested final validation failure.");
  }

  return { artifactPath: `${repository}/results/result.json`, summary: JSON.stringify(result) };
}
