import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "apps/web",
  plugins: [react(), tailwindcss()],
  server: {
    port: 4310,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:4311", ws: true } },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
