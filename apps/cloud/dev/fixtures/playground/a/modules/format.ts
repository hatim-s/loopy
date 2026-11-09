import { type Context, finish, put, type RunInput, read } from "./repository";

export default async (input: RunInput, context: Context) => {
  const changed: string[] = [];

  for (const path of ["README.md", "src/math.ts", "src/status.ts"]) {
    const before = await read(context, path);

    const after = `${before
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd()}\n`;

    await put(context, path, after);

    if (before !== after) {
      changed.push(path);
    }

    context.log("format-file", { path, removedBytes: before.length - after.length });
  }

  return finish(input, context, "playground-a-format-report", [
    {
      path: "reports/format.md",
      content: `# Format report\n\nNormalized trailing whitespace in ${changed.length} files.\n\n${changed.map((path) => `- ${path}`).join("\n")}\n`,
    },
  ]);
};
