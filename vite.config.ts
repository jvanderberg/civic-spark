import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Write .br and .gz siblings for built assets so the server serves them as-is
// instead of compressing on every request. Runs inside the build, so the
// deployment context needs no extra script.
function precompress(): Plugin {
  let outDir = "";
  const extensions = /\.(js|mjs|css|html|svg|json|txt|map|webmanifest|xml)$/;
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return {
    name: "civic-spark-precompress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      let files = 0;
      for (const path of walk(outDir)) {
        if (!extensions.test(path) || statSync(path).size < 1024) continue;
        const source = readFileSync(path);
        writeFileSync(
          `${path}.br`,
          brotliCompressSync(source, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: 11,
              [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
            },
          }),
        );
        writeFileSync(`${path}.gz`, gzipSync(source, { level: 9 }));
        files++;
      }
      this.info(`precompressed ${files} files`);
    },
  };
}

export default defineConfig({
  root: "apps/web",
  plugins: [react(), tailwindcss(), precompress()],
  server: {
    port: 4310,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:4311", ws: true } },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
