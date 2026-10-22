import { mkdir, writeFile } from "node:fs/promises";
import { digest, type PlaygroundInput, repository } from "./repository.js";

export default async function seed({ input, slug }: { input: PlaygroundInput; slug: string }) {
  for (const directory of ["data", "docs", "src", "results"]) {
    await mkdir(`${repository}/${directory}`, { recursive: true });
  }

  const rows = input.items.slice(0, 24).map((value, index) => `${index + 1},${value}`);
  const csv = `id,value\n${rows.join("\n")}\n`;
  await writeFile(`${repository}/data/records.csv`, csv);
  await writeFile(
    `${repository}/README.md`,
    `# Synthetic repository\n\nWorkflow ${slug}, batch ${input.batch}, ordinal ${input.ordinal}.\n`,
  );
  await writeFile(
    `${repository}/docs/policy.md`,
    "# Local review policy\n\nNo network calls. Synthetic data only. Approval required for publication.\n",
  );
  await writeFile(`${repository}/src/limits.ts`, "export const maxRecords = 24;\n");
  console.log(`Seeded ${rows.length} synthetic records for ${slug}.`);

  return { records: rows.length, sourceHash: digest(csv) };
}
