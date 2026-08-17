import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The publishable CLI bundle must contain only Studio's compiled application.
 * The development config exposes the checked-in demo fixture through
 * `publicDir`; package builds deliberately disable that directory.
 */
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    emptyOutDir: true,
    outDir: "../../packages/cli/dist/studio",
  },
});
