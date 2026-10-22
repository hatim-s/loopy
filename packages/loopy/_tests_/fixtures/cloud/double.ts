export default (
  { item, index }: { item: number; index: number },
  context: { log(message: string, data: { item: number; index: number }): void },
) => {
  context.log("double-item", { item, index });

  return { doubled: item * 2, index };
};
