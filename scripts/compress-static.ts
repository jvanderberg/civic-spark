// Precompress built web assets so the server can send .br/.gz files as-is
// instead of compressing on every request. Runs after `vite build`.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = resolve(process.argv[2] ?? "dist/web");
const extensions = /\.(js|mjs|css|html|svg|json|txt|map|webmanifest|xml)$/;
let files = 0;
let before = 0;
let after = 0;
function walk(directory: string) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    if (!extensions.test(name) || statSync(path).size < 1024) continue;
    const source = readFileSync(path);
    const br = brotliCompressSync(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    });
    writeFileSync(`${path}.br`, br);
    writeFileSync(`${path}.gz`, gzipSync(source, { level: 9 }));
    files++;
    before += source.length;
    after += br.length;
  }
}
walk(root);
console.log(
  `Precompressed ${files} files: ${(before / 1024).toFixed(0)} KiB -> ${(after / 1024).toFixed(0)} KiB (brotli)`,
);
