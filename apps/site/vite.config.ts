import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { THEME_BOOT, THEME_COLOR } from "./src/lib/theme";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "theme-boot",
      transformIndexHtml: () => [
        {
          tag: "meta",
          attrs: { name: "theme-color", content: THEME_COLOR.dark },
          injectTo: "head",
        },
        { tag: "script", children: THEME_BOOT, injectTo: "head" },
      ],
    },
  ],
  server: { port: 4280 },
});
