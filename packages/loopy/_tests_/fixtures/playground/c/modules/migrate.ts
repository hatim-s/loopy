import { writeFile } from "node:fs/promises";
import { digest, type PlaygroundInput, readSource, repository, writeResult } from "./repository.js";

export default async function migrate({
  input,
  approved,
}: {
  input: PlaygroundInput;
  approved: boolean;
}) {
  if (!approved) {
    throw new Error("PLAYGROUND_APPROVAL_DENIED: migration requires approval.");
  }

  const source = await readSource("data/records.csv");
  const rows = source.trim().split("\n").slice(1);
  const migrated = `id,value,migration\n${rows.map((row) => `${row},${input.ordinal}`).join("\n")}\n`;
  await writeFile(`${repository}/data/migrated.csv`, migrated);

  return writeResult(input, "playground-c-data-migration", {
    approved,
    records: rows.length,
    sourceHash: digest(source),
    migratedHash: digest(migrated),
    changedFile: "data/migrated.csv",
  });
}
