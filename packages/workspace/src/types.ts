import { z } from "zod";

export const FILE_LIMIT = 25 * 1024 * 1024;
export const TREE_LIMIT = 50 * 1024 * 1024;
export const DIFF_FILE_LIMIT = 1024 * 1024;
// Transport budgets include JSON metadata and worst-case escaping, not extra file data.
export const BLOB_BODY_LIMIT = Math.ceil(FILE_LIMIT / 3) * 4 + 65536;
export const TEXT_BODY_LIMIT = FILE_LIMIT * 6 + 65536;
const excluded = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  "vendor",
  "credentials",
  "secrets",
]);
export function projectPath(path: string): boolean {
  return (
    path.length <= 500 &&
    ![...path].some((c) => c.charCodeAt(0) < 32) &&
    !/[\\<>:"|?*]/.test(path) &&
    path
      .split("/")
      .every(
        (part) =>
          Boolean(part) &&
          !part.startsWith(".") &&
          !/[. ]$/.test(part) &&
          !excluded.has(part.toLowerCase()) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
          !/\.(pem|key|p12|pfx|log)$/i.test(part),
      )
  );
}
export const stampSchema = z.object({ revision: z.string(), size: z.number() });
export const manifestSchema = z.object({
  files: z.record(z.string(), stampSchema),
  skipped: z.array(z.string()),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type Stamp = z.infer<typeof stampSchema>;
export const blobSchema = z.object({ path: z.string(), data: z.string(), revision: z.string() });
export type FileBlob = z.infer<typeof blobSchema>;
export const mutationSchema = z.object({
  path: z.string().refine(projectPath, "This path is excluded from workspace sync"),
  revision: z.string().nullable(),
  data: z
    .string()
    .max(Math.ceil(FILE_LIMIT / 3) * 4)
    .nullable(),
});
export type FileMutation = z.infer<typeof mutationSchema>;
export const changesSchema = z.object({
  base: z.string(),
  revision: z.string().optional(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(["added", "modified", "deleted"]),
      diff: z.string(),
      binary: z.boolean(),
    }),
  ),
});
export type Changes = z.infer<typeof changesSchema>;
