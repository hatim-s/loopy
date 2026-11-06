import { writeFile } from "node:fs/promises";
import { digest, readSource, repository, sourceFiles } from "./repository";

export default async function manifestPlan() {
  const entries: string[] = [];

  for (const file of sourceFiles) {
    entries.push(`${digest(await readSource(file))}  ${file}`);
  }

  const manifest = `${entries.join("\n")}\n`;
  await writeFile(`${repository}/results/source-manifest.sha256`, manifest);
  console.log(`Prepared manifest with ${entries.length} repository files.`);

  return { files: entries.length, manifestHash: digest(manifest) };
}
