import { dirname, resolve } from "node:path";

export const typescriptPaths: Bun.BunPlugin = {
  name: "typescript-source-paths",
  setup(build) {
    build.onResolve({ filter: /^(?:\.|\/).*\.js$/ }, async ({ path, importer }) => {
      const javascript = resolve(dirname(importer), path);

      if (await Bun.file(javascript).exists()) {
        return undefined;
      }

      const typescript = javascript.replace(/\.js$/, ".ts");

      return (await Bun.file(typescript).exists()) ? { path: typescript } : undefined;
    });
  },
};
