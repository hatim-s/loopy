import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  publicDir: "../../fixtures/studio",
  server: { port: 4173 },
});
