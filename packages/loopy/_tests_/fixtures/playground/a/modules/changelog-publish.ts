import { type Context, finish, type RunInput, read } from "./repository";

export default async (input: Pick<RunInput, "batch" | "ordinal">, context: Context) => {
  const draft = await read(context, "docs/changelog-draft.md");

  return finish(input, context, "playground-a-changelog-approval", [
    {
      path: "CHANGELOG.md",
      content: `${draft}\nApproved by the local playground cohort.\n`,
    },
  ]);
};
