import { type Context, readItems } from "./repository";

export default ({ item, index }: { item: number; index: number }, context: Context) => {
  const values = readItems();

  if (values[index] !== item) {
    throw new Error("Synthetic matrix input differs from the seeded repository.");
  }

  const score = Math.abs(item) * 3 + index;
  context.log("matrix-shard-passed", { index, assertions: 3, score });

  return { score };
};
