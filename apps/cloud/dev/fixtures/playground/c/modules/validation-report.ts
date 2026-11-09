import { writeFile } from "node:fs/promises";
import { digest, type PlaygroundInput, readSource, repository, writeResult } from "./repository";

export default async function validationReport({
  input,
  checked,
}: {
  input: PlaygroundInput;
  checked: { file: string; bytes: number; hash: string }[];
}) {
  const csv = await readSource("data/records.csv");
  const records = csv.trim().split("\n").slice(1);
  const valid = records.every((row, index) => row.startsWith(`${index + 1},`));

  if (!valid || checked.length !== 3) {
    throw new Error("PLAYGROUND_REPOSITORY_INVALID: source validation did not match the seed.");
  }

  const report = checked
    .map(({ file, bytes, hash }) => `- ${file}: ${bytes} bytes, sha256 ${hash}`)
    .join("\n");

  await writeFile(
    `${repository}/docs/validation.md`,
    `# Repository validation\n\n${report}\n\nRecords: ${records.length}.\n`,
  );

  return writeResult(input, "playground-c-repository-validation", {
    records: records.length,
    validatedFiles: checked.map(({ file }) => file),
    sourceHash: digest(csv),
    changedFile: "docs/validation.md",
  });
}
