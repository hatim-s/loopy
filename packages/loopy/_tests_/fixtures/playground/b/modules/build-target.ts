import { writeFileSync } from "node:fs";
import { type Context, readItems, root } from "./repository";

export default ({ target }: { target: string }, context: Context) => {
  const values = readItems();
  const multiplier = target === "client" ? 2 : 5;
  const bytes = values.reduce((total, value) => total + Math.abs(value) * multiplier + 16, 0);
  writeFileSync(`${root}/docs/build-${target}.txt`, `${target}\n${bytes}\n`);
  context.log("build-target-complete", { target, bytes, modules: values.length });

  return { bytes };
};
