import { writeFile } from "node:fs/promises";
import { digest, type PlaygroundInput, readSource, repository, writeResult } from "./repository.js";

export default async function manifestPublish({
  input,
  approved,
  expectedHash,
}: {
  input: PlaygroundInput;
  approved: boolean;
  expectedHash: string;
}) {
  if (!approved) {
    throw new Error("PLAYGROUND_APPROVAL_DENIED: manifest publication requires approval.");
  }

  const manifest = await readSource("results/source-manifest.sha256");

  if (digest(manifest) !== expectedHash) {
    throw new Error("PLAYGROUND_MANIFEST_CHANGED: regenerate the manifest before publication.");
  }

  await writeFile(
    `${repository}/docs/artifacts.md`,
    `# Published artifacts\n\nOrdinal ${input.ordinal}, approved.\n\n${manifest}`,
  );

  return writeResult(input, "playground-c-artifact-manifest", {
    approved,
    files: manifest.trim().split("\n").length,
    manifestHash: expectedHash,
    changedFile: "docs/artifacts.md",
  });
}
