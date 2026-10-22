import { existsSync, writeFileSync } from "node:fs";
import { type Context, type Input, readItems, root, writeResult } from "./repository.ts";

export default (input: Input, context: Context) => {
  const marker = `${root}/docs/retry-started.txt`;
  const repeated = existsSync(marker);
  writeFileSync(marker, "A synthetic first attempt has run.\n");
  context.log("retry-marker", { repeated, controlledFailure: input.fail });

  if (!repeated || input.fail) {
    throw new Error("Controlled CI retry failure. The retry marker is safe to inspect.");
  }

  const values = readItems().map((value) => value + 1);
  writeFileSync(`${root}/src/ci-values.txt`, values.join("\n"));

  return writeResult(
    input,
    "playground-b-retry-marker",
    values,
    "Second attempt updated CI values",
  );
};
