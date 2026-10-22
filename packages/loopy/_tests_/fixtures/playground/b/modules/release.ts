import { writeFileSync } from "node:fs";
import { type Context, type Input, readItems, root, writeResult } from "./repository.ts";

export default (input: Input & { approved: boolean }, context: Context) => {
  context.log("release-approval-received", { approved: input.approved, ordinal: input.ordinal });

  if (!input.approved || input.fail) {
    throw new Error("Controlled release rejection after approval resolution.");
  }

  const values = readItems();
  writeFileSync(`${root}/docs/release.md`, `# Approved release\n\nBatch ${input.batch}\n`);

  return writeResult(input, "playground-b-release-approval", values, "Approved synthetic release");
};
