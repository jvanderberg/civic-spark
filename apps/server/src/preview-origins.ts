import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function validatePreviewOrigin(origin: string, portal: string) {
  const url = new URL(origin);
  const management = new URL(portal).hostname;
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.hostname === management ||
    url.hostname.endsWith(`.${management}`) ||
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Preview requires a separate exact HTTPS origin");
  return origin;
}
/** Single-writer gateway routing state. Bindings survive deletion and are never recycled. */
export class PreviewOriginPool {
  private bindings = new Map<string, string>();
  private path: string;
  readonly origins: string[];
  constructor(origins: string[], root: string, portal: string) {
    if (!Array.isArray(origins) || !origins.length || origins.length > 10000)
      throw new Error("Invalid preview origin pool");
    this.origins = origins.map((origin) => validatePreviewOrigin(origin, portal));
    if (new Set(this.origins.map((origin) => new URL(origin).hostname)).size !== origins.length)
      throw new Error("Preview origins must have distinct hostnames");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.path = join(root, "preview-origins.json");
    if (existsSync(this.path)) {
      const stored: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!stored || typeof stored !== "object" || Array.isArray(stored))
        throw new Error("Invalid saved preview bindings");
      for (const [workspace, origin] of Object.entries(stored)) {
        if (!/^[a-f0-9-]{36}$/.test(workspace) || typeof origin !== "string")
          throw new Error("Invalid saved preview bindings");
        this.bindings.set(workspace, validatePreviewOrigin(origin, portal));
      }
      if (new Set(this.bindings.values()).size !== this.bindings.size)
        throw new Error("Preview origins cannot be reassigned");
    }
  }
  assign(workspace: string) {
    if (!/^[a-f0-9-]{36}$/.test(workspace)) throw new Error("Invalid preview workspace");
    const existing = this.bindings.get(workspace);
    if (existing) {
      if (!this.origins.includes(existing))
        throw new Error(
          "This workspace's preview origin is unavailable. Contact the event administrator.",
        );
      return existing;
    }
    const used = new Set([...this.bindings.values()].map((origin) => new URL(origin).hostname));
    const origin = this.origins.find((candidate) => !used.has(new URL(candidate).hostname));
    if (!origin)
      throw new Error(
        "Preview capacity is full. Ask the event administrator to add preview capacity.",
      );
    const next = new Map(this.bindings).set(workspace, origin);
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(next)), {
      mode: 0o600,
      flush: true,
    });
    renameSync(temporary, this.path);
    this.bindings = next;
    const directory = openSync(dirname(this.path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return origin;
  }
}
