import { type Context, read } from "./repository.js";

export default async ({ item, index }: { item: number; index: number }, context: Context) => {
  const path = index % 2 === 0 ? "src/math.ts" : "src/status.ts";
  const source = await read(context, path);
  const findings = source.split("\n").filter((line) => line.trimEnd() !== line).length;
  context.log("lint-source-read", { path, check: item, findings });

  return { check: item, findings };
};
