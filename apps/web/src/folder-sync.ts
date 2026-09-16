import { z } from "zod";
import { type Baseline, planSync, type SyncStep } from "../../../packages/workspace/src/sync.ts";
import {
  FILE_LIMIT,
  type FileBlob,
  type Manifest,
  projectPath,
  TREE_LIMIT,
} from "../../../packages/workspace/src/types.ts";
import { api } from "./api.ts";

export interface LocalFile {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: Uint8Array | string): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
}
export interface LocalFolder {
  kind: "directory";
  name: string;
  values(): AsyncIterable<LocalFile | LocalFolder>;
  getFileHandle(name: string, options?: { create: boolean }): Promise<LocalFile>;
  getDirectoryHandle(name: string, options?: { create: boolean }): Promise<LocalFolder>;
  removeEntry(name: string): Promise<void>;
}
export const directorySupport = () => "showDirectoryPicker" in window;
export function pickDirectory(): Promise<LocalFolder> {
  return (
    window as unknown as { showDirectoryPicker(options: object): Promise<LocalFolder> }
  ).showDirectoryPicker({ mode: "readwrite", id: "vibehack-workspace" });
}
async function digest(data: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function decode(data: string): Uint8Array {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
function encode(data: Uint8Array): string {
  let text = "";
  for (let i = 0; i < data.length; i += 8192)
    text += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(text);
}
async function parent(root: LocalFolder, path: string, create = false) {
  if (!projectPath(path)) throw new Error("Path excluded from sync");
  const parts = path.split("/");
  const name = parts.pop();
  if (!name) throw new Error("Missing filename");
  let folder = root;
  for (const part of parts) folder = await folder.getDirectoryHandle(part, { create });
  return { folder, name };
}
export async function localRead(root: LocalFolder, path: string): Promise<FileBlob | null> {
  try {
    const { folder, name } = await parent(root, path);
    const file = await (await folder.getFileHandle(name)).getFile();
    if (file.size > FILE_LIMIT) throw new Error(`${path} exceeds the 25 MiB sync limit`);
    const data = new Uint8Array(await file.arrayBuffer());
    return { path, data: encode(data), revision: await digest(data) };
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotFoundError") return null;
    throw e;
  }
}
export async function localManifest(root: LocalFolder): Promise<Manifest> {
  const files: Manifest["files"] = Object.create(null);
  const skipped: string[] = [];
  const cases = new Set<string>();
  let total = 0;
  async function walk(folder: LocalFolder, prefix = "") {
    for await (const entry of folder.values()) {
      const path = prefix + entry.name;
      if (!projectPath(path)) {
        skipped.push(path);
        continue;
      }
      if (entry.kind === "directory") await walk(entry, `${path}/`);
      else {
        const file = await localRead(root, path);
        if (!file) throw new Error("A local file moved during the scan. Try sync again.");
        const size = decode(file.data).length;
        total += size;
        if (total > TREE_LIMIT || Object.keys(files).length >= 5000)
          throw new Error("Folder exceeds the 50 MiB / 5,000 file sync limit");
        if (cases.has(path.toLowerCase()))
          throw new Error("Filenames differ only by case; rename before syncing");
        cases.add(path.toLowerCase());
        files[path] = { revision: file.revision, size };
      }
    }
  }
  await walk(root);
  return { files, skipped };
}
const marker = ".vibehack-sync.json";
const checkpointSchema = z.object({
  version: z.literal(1),
  workspace: z.string(),
  baseline: z.record(z.string().refine(projectPath), z.string()),
});
export class FolderSync {
  baseline: Baseline = Object.create(null);
  constructor(
    readonly root: LocalFolder,
    readonly workspace: string,
    readonly stillConnected: () => boolean,
  ) {}
  async connect() {
    try {
      const checkpoint = await (await (await this.root.getFileHandle(marker)).getFile()).text();
      // A failed first write can leave an empty newly-created marker. Reconcile from scratch safely.
      if (!checkpoint.trim()) return;
      const saved = checkpointSchema.parse(JSON.parse(checkpoint));
      if (saved.workspace !== this.workspace)
        throw new Error("This folder belongs to another workspace. Choose a different folder.");
      this.baseline = saved.baseline;
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
    }
  }
  async preview() {
    const [local, remote] = await Promise.all([
      localManifest(this.root),
      api<Manifest>(`/workspaces/${this.workspace}/manifest`),
    ]);
    return { local, remote, steps: planSync(this.baseline, local, remote) };
  }
  private async checkpoint() {
    const handle = await this.root.getFileHandle(marker, { create: true });
    const writer = await handle.createWritable();
    try {
      await writer.write(
        JSON.stringify({ version: 1, workspace: this.workspace, baseline: this.baseline }),
      );
      await writer.close();
    } catch (e) {
      await writer.abort().catch(() => {});
      throw e;
    }
  }
  async apply(
    steps: SyncStep[],
    choices: Record<string, "upload" | "download"> = {},
    onProgress?: (progress: { completed: number; total: number; path: string | null }) => void,
  ) {
    let completed = 0;
    for (const step of steps) {
      onProgress?.({ completed, total: steps.length, path: step.path });
      if (!this.stillConnected()) throw new Error("Sync paused");
      const direction = step.direction === "conflict" ? choices[step.path] : step.direction;
      if (!direction) throw new Error("Choose a version for every conflict first");
      const current = await localRead(this.root, step.path);
      if ((current?.revision ?? null) !== step.local)
        throw new Error(`${step.path} changed locally after preview. Refresh to reconcile.`);
      if (direction === "upload") {
        await api(`/workspaces/${this.workspace}/blob`, "PUT", {
          path: step.path,
          revision: step.remote,
          data: current?.data ?? null,
        });
      } else {
        // A blob read verifies ownership and returns its revision; only deletions
        // need a fresh manifest. Never infer deletion from a failed blob read.
        if (step.remote === null) {
          const remote = await api<Manifest>(`/workspaces/${this.workspace}/manifest`);
          if (remote.files[step.path])
            throw new Error(`${step.path} changed remotely after preview. Refresh to reconcile.`);
        }
        const next = step.remote
          ? await api<FileBlob>(
              `/workspaces/${this.workspace}/blob?path=${encodeURIComponent(step.path)}`,
            )
          : null;
        if ((next?.revision ?? null) !== step.remote)
          throw new Error("Remote file changed during transfer");
        if (!this.stillConnected()) throw new Error("Sync paused");
        if (((await localRead(this.root, step.path))?.revision ?? null) !== step.local)
          throw new Error("Local file changed during transfer");
        const { folder, name } = await parent(this.root, step.path, next !== null);
        if (next === null) {
          if (current) await folder.removeEntry(name);
        } else {
          const writer = await (
            await folder.getFileHandle(name, { create: true })
          ).createWritable();
          try {
            await writer.write(decode(next.data));
            await writer.close();
          } catch (e) {
            await writer.abort().catch(() => {});
            throw e;
          }
        }
      }
      const revision = direction === "upload" ? step.local : step.remote;
      if (revision === null) delete this.baseline[step.path];
      else this.baseline[step.path] = revision;
      await this.checkpoint();
      completed++;
      onProgress?.({ completed, total: steps.length, path: null });
    }
    // A transfer interrupted after a write is recovered when both copies agree.
    const fresh = await this.preview();
    for (const [path, value] of Object.entries(fresh.local.files)) {
      if (fresh.remote.files[path]?.revision === value.revision)
        this.baseline[path] = value.revision;
    }
    for (const path of Object.keys(this.baseline)) {
      if (
        !fresh.local.files[path] &&
        !fresh.remote.files[path] &&
        ![...fresh.local.skipped, ...fresh.remote.skipped].some(
          (p) => path === p || path.startsWith(`${p}/`),
        )
      )
        delete this.baseline[path];
    }
    await this.checkpoint();
    return fresh;
  }
}
