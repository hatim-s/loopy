import { mkdirSync, writeFileSync } from "node:fs";
import { type Context, type Input, root } from "./repository";

export default (input: Input, context: Context) => {
  mkdirSync(`${root}/src`, { recursive: true });
  mkdirSync(`${root}/docs`, { recursive: true });
  writeFileSync(`${root}/src/ci-values.txt`, input.items.join("\n"));
  writeFileSync(`${root}/README.md`, "# Synthetic CI repository\n\nLocal playground data only.\n");
  writeFileSync(`${root}/docs/batch.txt`, `${input.batch}\n${input.ordinal}\n`);
  context.log("ci-repository-seeded", { ordinal: input.ordinal, files: 3 });

  return { count: input.items.length };
};
