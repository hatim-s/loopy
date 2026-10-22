import { type Context, put, type RunInput, read } from "./repository.js";

export default async (input: RunInput, context: Context) => {
  const changelog = await read(context, "CHANGELOG.md");

  const entries = input.items
    .slice(0, 8)
    .map((item) => `- Maintenance item ${item}.`)
    .join("\n");

  await put(context, "docs/changelog-draft.md", `${changelog}\n${entries}\n`);
  context.log("changelog-draft-saved", { ordinal: input.ordinal, entries: input.items.length });

  return { entries: input.items.length };
};
