import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiOrigin = process.env.LOOPY_API_ORIGIN ?? "http://127.0.0.1:4310";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    // The contract is read from source so dev mode does not depend on a package build.
    alias: {
      "loopy/contract": fileURLToPath(
        new URL("../../packages/loopy/src/contract/index.ts", import.meta.url),
      ),
    },
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
