import { spawnSync } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { expect, it } from "vitest";
import { unzipFile, zipDirectory } from "../packages/backup/src/zip.ts";

// A backup of a few dozen team repositories holds tens of thousands of Git objects; the
// classic ZIP end record counts at most 65,535 entries.
it("writes and reads ZIPs with more than 65,535 entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-zip64-"));
  try {
    const source = join(root, "source");
    const objects = join(source, "data", "objects");
    mkdirSync(objects, { recursive: true });
    for (let index = 0; index < 66_000; index++)
      mkdirSync(join(objects, index.toString(16).padStart(5, "0")));
    writeFileSync(join(source, "data", "state.json"), '{"events":1}\n');
    writeFileSync(join(objects, "00000", "object"), "blob contents\n");
    const zip = join(root, "backup.zip");
    await pipeline(zipDirectory(source, "civic-spark-backup"), createWriteStream(zip));

    // Independent readers accept it.
    const unzip = spawnSync("unzip", ["-tq", zip], { encoding: "utf8" });
    if (!unzip.error) expect(unzip.stdout).toContain("No errors detected");

    const destination = join(root, "extracted");
    mkdirSync(destination);
    const names = await unzipFile(zip, destination);
    expect(names.sort()).toEqual(["data/objects/00000/object", "data/state.json"]);
    expect(readdirSync(join(destination, "data", "objects"))).toHaveLength(66_000);
    expect(readFileSync(join(destination, "data", "objects", "00000", "object"), "utf8")).toBe(
      "blob contents\n",
    );
    expect(readFileSync(join(destination, "data", "state.json"), "utf8")).toBe('{"events":1}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

it("keeps the classic end record for smaller ZIPs", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-zip-"));
  try {
    const source = join(root, "source");
    mkdirSync(source);
    writeFileSync(join(source, "file.txt"), "hello\n");
    const zip = join(root, "small.zip");
    await pipeline(zipDirectory(source, "small"), createWriteStream(zip));
    const bytes = readFileSync(zip);
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(false);
    const destination = join(root, "extracted");
    mkdirSync(destination);
    await unzipFile(zip, destination);
    expect(readFileSync(join(destination, "file.txt"), "utf8")).toBe("hello\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
