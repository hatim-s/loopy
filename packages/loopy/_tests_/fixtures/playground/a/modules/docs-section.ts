import { type Context, read } from "./repository.js";

export default async ({ item, index }: { item: number; index: number }, context: Context) => {
  const path = index % 2 === 0 ? "src/math.ts" : "src/status.ts";
  const source = (await read(context, path)).trim();
  context.log("documented-source", { path, section: index });

  return `## Example ${item}\n\nSource: ${path}\n\n\`\`\`ts\n${source}\n\`\`\`\n`;
};
