export default (
  { name }: { name: string },
  context: { log(message: string, data: { name: string }): void },
) => {
  context.log("bundle-greeting", { name });

  return { greeting: `Hello ${name}`, uid: process.getuid?.() ?? -1 };
};
