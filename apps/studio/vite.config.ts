import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiOrigin = process.env.LOOPY_API_ORIGIN ?? "http://127.0.0.1:4310";

// Studio bundles the portable core barrel straight from source, so it builds
// and runs in dev without a prior package build.
const core = fileURLToPath(new URL("../../packages/loopy/src/core/index.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { loopy: core },
  },
  server: {
    port: 4173,
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
