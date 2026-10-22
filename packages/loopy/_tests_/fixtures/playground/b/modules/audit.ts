import { writeFileSync } from "node:fs";
import { type Context, type Input, readItems, root, writeResult } from "./repository.ts";

export default (input: Input, context: Context) => {
  const values = readItems();
  const count = 12 + (input.ordinal % 9);

  for (let index = 0; index < count; index++) {
    context.log("audit-record", {
      index,
      ordinal: input.ordinal,
      severity: index % 4 === 0 ? "notice" : "info",
      rule: `synthetic-ci-rule-${index % 7}`,
      evidence: "Repository values checked without network access.",
    });
  }

  if (input.fail) {
    throw new Error("Controlled audit policy failure after bounded evidence logs.");
  }

  const sorted = values.sort((left, right) => left - right);
  writeFileSync(
    `${root}/docs/audit.md`,
    `# CI audit\n\nRecords ${count}\nValues ${sorted.join(", ")}\n`,
  );

  return writeResult(input, "playground-b-log-audit", sorted, `${count} audit records checked`);
};
