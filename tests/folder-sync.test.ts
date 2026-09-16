import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  decode,
  FolderSync,
  type LocalFile,
  type LocalFolder,
  localRead,
} from "../apps/web/src/folder-sync.ts";

class Folder implements LocalFolder {
  kind = "directory" as const;
  constructor(readonly name = "test") {}
  entries = new Map<string, Folder | Uint8Array>();
  revoked = false;
  checkpointFailure = false;
  async *values(): AsyncIterable<LocalFile | LocalFolder> {
    for (const [name, value] of this.entries) {
      if (this.revoked) throw new DOMException("Access revoked", "NotAllowedError");
      yield value instanceof Folder ? value : await this.getFileHandle(name);
    }
  }
  async getDirectoryHandle(name: string, options?: { create: boolean }): Promise<Folder> {
    if (!this.entries.has(name) && options?.create) this.entries.set(name, new Folder(name));
    const entry = this.entries.get(name);
    if (!(entry instanceof Folder)) throw new DOMException("Missing", "NotFoundError");
    return entry;
  }
  async getFileHandle(name: string, options?: { create: boolean }): Promise<LocalFile> {
    if (this.revoked) throw new DOMException("Access revoked", "NotAllowedError");
    if (!this.entries.has(name) && options?.create) this.entries.set(name, new Uint8Array());
    if (!this.entries.has(name)) throw new DOMException("Missing", "NotFoundError");
    return {
      kind: "file",
      name,
      getFile: async () => new File([this.entries.get(name) as Uint8Array<ArrayBuffer>], name),
      createWritable: async () => {
        let pending = new Uint8Array();
        return {
          write: async (input: string | Uint8Array) => {
            if (name === ".vibehack-sync.json" && this.checkpointFailure)
              throw new Error("Disk full");
            pending = new Uint8Array(
              typeof input === "string" ? new TextEncoder().encode(input) : input,
            );
          },
          close: async () => {
            this.entries.set(name, pending);
          },
          abort: async () => {},
        };
      },
    };
  }
  async removeEntry(name: string) {
    this.entries.delete(name);
  }
  set(name: string, text: string) {
    this.entries.set(name, new TextEncoder().encode(text));
  }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function remoteStore(initial: Record<string, string>) {
  const files = { ...initial };
  const fetch = vi.fn(async (url: string, options?: { method: string; body?: string }) => {
    if (url.endsWith("/manifest"))
      return Response.json({
        files: Object.fromEntries(
          Object.entries(files).map(([path, data]) => [
            path,
            { revision: hash(data), size: data.length },
          ]),
        ),
        skipped: [],
      });
    if (options?.method === "PUT") {
      const input = JSON.parse(options.body ?? "{}");
      const revision = files[input.path] === undefined ? null : hash(files[input.path] as string);
      if (input.revision !== revision)
        return Response.json({ error: "Remote changed" }, { status: 409 });
      if (input.data === null) delete files[input.path];
      else files[input.path] = Buffer.from(input.data, "base64").toString();
      return Response.json({
        revision: files[input.path] === undefined ? null : hash(files[input.path] as string),
      });
    }
    const path = new URL(url, "http://localhost").searchParams.get("path") ?? "";
    return Response.json({
      path,
      revision: hash(files[path] ?? ""),
      data: Buffer.from(files[path] ?? "").toString("base64"),
    });
  });
  vi.stubGlobal("fetch", fetch);
  return { files, fetch };
}
afterEach(() => vi.unstubAllGlobals());
it("preserves local and remote edits when either copy changed after preview", async () => {
  const folder = new Folder();
  folder.set("data.csv", "local");
  const remote = remoteStore({ "data.csv": "remote" });
  const sync = new FolderSync(folder, "workspace", () => true);
  await sync.connect();
  const preview = await sync.preview();
  expect(preview.steps[0]?.direction).toBe("conflict");
  folder.set("data.csv", "new local edit");
  await expect(sync.apply(preview.steps, { "data.csv": "download" })).rejects.toThrow(
    "changed locally",
  );
  expect(remote.files["data.csv"]).toBe("remote");
  const next = await sync.preview();
  remote.files["data.csv"] = "new remote edit";
  await expect(sync.apply(next.steps, { "data.csv": "upload" })).rejects.toThrow("Remote changed");
  expect(remote.files["data.csv"]).toBe("new remote edit");
});
it("recovers a completed transfer after checkpoint failure and binds folders to one workspace", async () => {
  const folder = new Folder();
  folder.set("data.csv", "local");
  const remote = remoteStore({});
  const sync = new FolderSync(folder, "workspace", () => true);
  const preview = await sync.preview();
  folder.checkpointFailure = true;
  await expect(sync.apply(preview.steps)).rejects.toThrow("Disk full");
  expect(remote.files["data.csv"]).toBe("local");
  folder.checkpointFailure = false;
  // Reconnect also recovers an empty marker left by a failed first checkpoint.
  const restarted = new FolderSync(folder, "workspace", () => true);
  await restarted.connect();
  const fresh = await restarted.preview();
  expect(fresh.steps).toEqual([]);
  await restarted.apply([]);
  expect(restarted.baseline["data.csv"]).toBe(hash("local"));
  await expect(new FolderSync(folder, "another-workspace", () => true).connect()).rejects.toThrow(
    "another workspace",
  );
});
it("stops on lost directory permission and disconnect without deleting remote files", async () => {
  const folder = new Folder();
  folder.set("data.csv", "local");
  const remote = remoteStore({ "data.csv": "remote" });
  const sync = new FolderSync(folder, "workspace", () => false);
  const preview = await sync.preview();
  await expect(sync.apply(preview.steps, { "data.csv": "upload" })).rejects.toThrow("paused");
  folder.revoked = true;
  await expect(sync.preview()).rejects.toThrow("revoked");
  expect(remote.files["data.csv"]).toBe("remote");
});
it("syncs a CSV larger than 1 MiB initially and in both directions without losing revisions", async () => {
  const folder = new Folder();
  const original = `category,value\n${"trees,1234\n".repeat(120000)}`;
  const remote = remoteStore({ "data.csv": original });
  const sync = new FolderSync(folder, "large-workspace", () => true);
  await sync.connect();
  await sync.apply((await sync.preview()).steps);
  const localText = () => new TextDecoder().decode(folder.entries.get("data.csv") as Uint8Array);
  expect(localText()).toBe(original);
  folder.set("data.csv", `${original}parks,456\n`);
  await sync.apply((await sync.preview()).steps);
  expect(remote.files["data.csv"]).toBe(`${original}parks,456\n`);
  remote.files["data.csv"] += "roads,789\n";
  await sync.apply((await sync.preview()).steps);
  expect(localText()).toBe(remote.files["data.csv"]);
  expect((await sync.preview()).steps).toEqual([]);
  folder.entries.set("data.csv", new Uint8Array(25 * 1024 * 1024 + 1));
  await expect(sync.preview()).rejects.toThrow("25 MiB");
  expect(remote.files["data.csv"]).toBe(`${original}parks,456\nroads,789\n`);
}, 30000);

it("reads and decodes an exact 25 MiB browser file without dropping binary bytes", async () => {
  const folder = new Folder();
  const bytes = new Uint8Array(25 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  folder.entries.set("data.bin", bytes);
  const blob = await localRead(folder, "data.bin");
  if (!blob) throw new Error("Missing file");
  const decoded = decode(blob.data);
  expect(Buffer.from(decoded).equals(Buffer.from(bytes))).toBe(true);
}, 30000);

it("downloads every nested CSV, reports progress, and resumes a partly completed transfer", async () => {
  const folder = new Folder();
  const csvs = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `data/crashes_${2014 + i}.csv`,
      `year,value\n${2014 + i},42\n`,
    ]),
  );
  const remote = remoteStore(csvs);
  let connected = true;
  const sync = new FolderSync(folder, "csv-workspace", () => connected);
  await sync.connect();
  const progress: number[] = [];
  await expect(
    sync.apply((await sync.preview()).steps, {}, (p) => {
      progress.push(p.completed);
      if (p.completed === 3) connected = false;
    }),
  ).rejects.toThrow("paused");
  expect(Object.keys(sync.baseline)).toHaveLength(3);
  const resumed = new FolderSync(folder, "csv-workspace", () => true);
  await resumed.connect();
  const preview = await resumed.preview();
  expect(preview.steps).toHaveLength(9);
  await resumed.apply(preview.steps);
  for (const [path, text] of Object.entries(csvs)) {
    const file = await localRead(folder, path);
    if (!file) throw new Error(`Missing ${path}`);
    expect(Buffer.from(file.data, "base64").toString()).toBe(text);
  }
  expect((await resumed.preview()).steps).toEqual([]);
  expect(progress).toContain(3);
  expect(remote.fetch.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(
    0,
  );
  // Data downloads use revision-bearing reads, not one full manifest scan per file.
  expect(remote.fetch.mock.calls.filter(([url]) => url.endsWith("/manifest")).length).toBeLessThan(
    10,
  );
});
