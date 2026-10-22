import { writeFile } from "node:fs/promises";
import { digest, type PlaygroundInput, readSource, repository, writeResult } from "./repository.js";

export default async function security({
  input,
  approved,
}: {
  input: PlaygroundInput;
  approved: boolean;
}) {
  if (!approved) {
    throw new Error("PLAYGROUND_APPROVAL_DENIED: security publication requires approval.");
  }

  const policy = await readSource("docs/policy.md");
  const source = await readSource("src/limits.ts");

  const forbidden = ["fetch(", "process.env", "child_process"].filter((term) =>
    source.includes(term),
  );

  if (forbidden.length > 0 || !policy.includes("Synthetic data only")) {
    throw new Error("PLAYGROUND_SECURITY_CHECK_FAILED: review the synthetic repository policy.");
  }

  const report = `# Security review\n\nOrdinal ${input.ordinal}: approved.\nChecked src/limits.ts and docs/policy.md.\nNo forbidden execution or network calls found.\n`;
  await writeFile(`${repository}/docs/security-review.md`, report);

  return writeResult(input, "playground-c-security-review", {
    approved,
    findings: forbidden.length,
    policyHash: digest(policy),
    sourceHash: digest(source),
    changedFile: "docs/security-review.md",
  });
}
