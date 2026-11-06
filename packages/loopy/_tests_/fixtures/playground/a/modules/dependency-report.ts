import { type Context, finish, type RunInput, read } from "./repository";

type Input = Pick<RunInput, "batch" | "ordinal"> & {
  inventory: { policy: string; count: number };
  review: { policy: string; count: number };
};

export default async (input: Input, context: Context) => {
  const manifest = await read(context, "dependencies.txt");

  return finish(input, context, "playground-a-dependency-audit", [
    {
      path: "reports/dependencies.md",
      content: `# Synthetic dependency audit\n\nInventoried ${input.inventory.count} packages.\nQueued ${input.review.count} packages for review.\n\nThis local policy does not consult a vulnerability database.\n\n${manifest}`,
    },
  ]);
};
