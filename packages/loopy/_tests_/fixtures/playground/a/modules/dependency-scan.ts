import { type Context, read } from "./repository.js";

export default async ({ policy }: { policy: "inventory" | "review" }, context: Context) => {
  const rows = (await read(context, "dependencies.txt")).trim().split("\n");

  const count =
    policy === "inventory" ? rows.length : rows.filter((row) => row.endsWith(" review")).length;

  context.log("dependency-policy", { policy, count });

  return { policy, count };
};
