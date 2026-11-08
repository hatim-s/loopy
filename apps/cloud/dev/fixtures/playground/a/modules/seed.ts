import { type Context, put, type RunInput, read } from "./repository";

export default async (input: RunInput, context: Context) => {
  await put(
    context,
    "README.md",
    "# Loopies playground   \n\nRepository maintenance fixtures.   \n",
  );
  await put(context, "src/math.ts", "export const sum = (a: number, b: number) => a + b;   \n");
  await put(context, "src/status.ts", 'export const status = "ready";   \n');
  await put(
    context,
    "dependencies.txt",
    "fixture-core 1.0.0 current\nfixture-legacy 0.9.0 review\n",
  );
  await put(
    context,
    "CHANGELOG.md",
    "# Changelog\n\n## Unreleased\n\nPending maintenance notes.\n",
  );
  const source = await read(context, "src/math.ts");
  context.log("repository-seeded", { ordinal: input.ordinal, sourceBytes: source.length });

  return { sourceBytes: source.length };
};
