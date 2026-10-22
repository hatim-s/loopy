import { writeFileSync } from "node:fs";
import { type Input, root, writeResult } from "./repository.ts";

export default ({ rows, ...input }: Input & { rows: { score: number }[] }) => {
  const values = rows.map((row) => row.score);
  writeFileSync(`${root}/docs/test-matrix.md`, `# Matrix results\n\n${values.join(", ")}\n`);

  return writeResult(
    input,
    "playground-b-test-matrix",
    values,
    "Three assertions per matrix shard",
  );
};
