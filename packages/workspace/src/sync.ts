import type { Manifest } from "./types.ts";

export type Baseline = Record<string, string>;
export type SyncStep = {
  path: string;
  direction: "upload" | "download" | "conflict";
  local: string | null;
  remote: string | null;
  deletion: boolean;
};
export function planSync(base: Baseline, local: Manifest, remote: Manifest): SyncStep[] {
  const result: SyncStep[] = [];
  for (const path of [
    ...new Set([...Object.keys(base), ...Object.keys(local.files), ...Object.keys(remote.files)]),
  ].sort()) {
    if ([...local.skipped, ...remote.skipped].some((p) => path === p || path.startsWith(`${p}/`)))
      continue;
    const l = local.files[path]?.revision ?? null;
    const r = remote.files[path]?.revision ?? null;
    const b = base[path] ?? null;
    if (l === r) continue;
    result.push({
      path,
      local: l,
      remote: r,
      direction: l === b ? "download" : r === b ? "upload" : "conflict",
      deletion: l === null || r === null,
    });
  }
  return result;
}
