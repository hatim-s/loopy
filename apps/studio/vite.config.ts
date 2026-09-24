import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiOrigin = process.env.LOOPY_API_ORIGIN ?? "http://127.0.0.1:4310";

export default defineConfig({
  plugins: [react()],
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
