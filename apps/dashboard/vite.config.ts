import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const apiOrigin = process.env.LOOPY_API_ORIGIN ?? "http://127.0.0.1:4310";

const require = createRequire(import.meta.url);

// Bun links these packages out of its global install cache, so their font files resolve outside
// the workspace and the dev server refuses them. Allow exactly these package directories.
const fontPackages = ["@fontsource-variable/geist", "@fontsource-variable/geist-mono"].map((name) =>
  dirname(realpathSync(require.resolve(`${name}/package.json`))),
);

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true, indexToken: "page" }),
    react(),
    tailwindcss(),
  ],
  server: {
    port: 4173,
    fs: {
      allow: [
        searchForWorkspaceRoot(fileURLToPath(new URL(".", import.meta.url))),
        ...fontPackages,
      ],
    },
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (request) => request.setHeader("origin", apiOrigin));
        },
      },
    },
  },
});
