import { type Context, finish, type RunInput } from "./repository";

type Input = Pick<RunInput, "batch" | "ordinal"> & {
  checks: { check: number; findings: number }[];
};

export default (input: Input, context: Context) =>
  finish(input, context, "playground-a-lint-report", [
    {
      path: "reports/lint.md",
      content: `# Lint report\n\nCompleted ${input.checks.length} source checks.\nFound ${input.checks.reduce((total, check) => total + check.findings, 0)} trailing whitespace findings.\n\nThe fixture treats whitespace as advisory.\n`,
    },
  ]);
