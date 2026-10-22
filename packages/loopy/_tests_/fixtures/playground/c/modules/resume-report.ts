import { writeFile } from "node:fs/promises";
import { digest, type PlaygroundInput, readSource, repository, writeResult } from "./repository.js";

export default async function resumeReport({ input }: { input: PlaygroundInput }) {
  const source = await readSource("data/records.csv");

  const values = source
    .trim()
    .split("\n")
    .slice(1)
    .map((row) => Number(row.split(",")[1]));

  const total = values.reduce((sum, value) => sum + value, 0);
  const report = `# Resumed report\n\nBatch ${input.batch}, ordinal ${input.ordinal}.\nRecords: ${values.length}.\nTotal: ${total}.\nSleep: 2 seconds.\n`;
  await writeFile(`${repository}/docs/resumed-report.md`, report);

  return writeResult(input, "playground-c-sleep-resume", {
    records: values.length,
    total,
    sleepSeconds: 2,
    sourceHash: digest(source),
    changedFile: "docs/resumed-report.md",
  });
}
