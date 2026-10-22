import { type Context, finish, type RunInput, read } from "./repository.js";

type Input = Pick<RunInput, "batch" | "ordinal"> & { sections: string[] };

export default async (input: Input, context: Context) => {
  const readme = await read(context, "README.md");

  return finish(input, context, "playground-a-generated-docs", [
    {
      path: "docs/api.md",
      content: `${readme.trim()}\n\n# Generated API examples\n\n${input.sections.slice(0, 8).join("\n")}\n`,
    },
  ]);
};
