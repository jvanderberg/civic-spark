import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { acquireWriter } from "../../../apps/server/src/deployment.ts";
import { validatePreviewOrigin } from "../../../apps/server/src/preview-origins.ts";
import { validateSpriteToken } from "../../sprites/src/credentials.ts";
import {
  certifiesSpriteResource,
  listWitnessesTarget,
  resourceAgreesWithWitness,
  spriteMembershipPath,
  spriteOrganizationListSchema,
  spriteResourceCandidateSchema,
} from "../../sprites/src/metadata.ts";
import { boundedProviderJson } from "../../sprites/src/provisioning.ts";
import { privateDirectory, syncPath, writePrivate } from "./archive.ts";
import { installationSchema } from "./backup.ts";
import { modeRoot, stateInventory } from "./verify.ts";

export const recoveryResourcesFile = ".civic-spark-recovery-resources.json";
export const recoveryResourcesSchema = z
  .object({
    version: z.literal(1),
    backupId: z.uuid(),
    provider: z.literal("sprites"),
    org: z.string().min(1),
    apiOrigin: z.url(),
    entries: z.array(
      z
        .object({
          workspaceId: z.uuid(),
          spriteName: z.string().regex(/^civic-spark-[a-z0-9-]{1,45}$/),
          status: z.literal("confirmed-missing"),
          observedAt: z.iso.datetime(),
          httpStatus: z.literal(404),
        })
        .strict(),
    ),
  })
  .strict();
export type RecoveryResources = z.infer<typeof recoveryResourcesSchema>;

function replacePrivate(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writePrivate(temporary, JSON.stringify(value));
    renameSync(temporary, path);
    syncPath(join(path, ".."));
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function readRecoveryResources(root: string): RecoveryResources | null {
  const path = join(root, recoveryResourcesFile);
  if (!existsSync(path)) return null;
  return recoveryResourcesSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
/** Only permission for a fresh provider existence check on explicit owner reopen. */
export function recoveryPermission(
  root: string,
  workspaceId: string,
  spriteName: string,
  org: string,
  apiOrigin = "https://api.sprites.dev",
) {
  const resources = readRecoveryResources(root);
  if (!resources) return null;
  const entry = resources.entries.find((e) => e.workspaceId === workspaceId);
  if (!entry) return null;
  if (resources.org !== org || resources.apiOrigin !== apiOrigin || entry.spriteName !== spriteName)
    throw new Error("Recovery reservation/provider mismatch");
  return entry;
}
/** Call only after canonical shared checkout is ready; retries must recheck the provider. */
export function completeRecovery(root: string, workspaceId: string, spriteName: string) {
  const resources = readRecoveryResources(root);
  if (!resources) return;
  const entry = resources.entries.find((e) => e.workspaceId === workspaceId);
  if (entry && entry.spriteName !== spriteName) throw new Error("Recovery reservation mismatch");
  replacePrivate(join(root, recoveryResourcesFile), {
    ...resources,
    entries: resources.entries.filter((e) => e.workspaceId !== workspaceId),
  });
}

// Confirmed administrative deletion retires all obsolete evidence for this workspace.
// Unlike checkout completion, no old reservation may authorize future recreation.
export function discardWorkspaceRecovery(root: string, workspaceId: string) {
  const resources = readRecoveryResources(root);
  if (!resources?.entries.some((entry) => entry.workspaceId === workspaceId)) return;
  replacePrivate(join(root, recoveryResourcesFile), {
    ...resources,
    entries: resources.entries.filter((entry) => entry.workspaceId !== workspaceId),
  });
}

export type RecoveryFetch = typeof fetch;
async function providerGet(
  path: string,
  org: string,
  apiOrigin: string,
  token: string,
  request: RecoveryFetch,
) {
  const api = new URL(apiOrigin);
  if (api.protocol !== "https:" || api.origin !== apiOrigin)
    throw new Error("Recovery requires an exact HTTPS provider API origin");
  validateSpriteToken(token, org);
  try {
    return await request(`${apiOrigin}/v1${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("Provider metadata request failed; resource existence remains unknown");
  }
}
export async function verifyRecoveryOrganization(
  org: string,
  apiOrigin: string,
  token: string,
  request: RecoveryFetch = fetch,
  targetName?: string,
) {
  await recoveryOrganization(org, apiOrigin, token, request, targetName);
}
async function recoveryOrganization(
  org: string,
  apiOrigin: string,
  token: string,
  request: RecoveryFetch,
  targetName?: string,
) {
  const response = await providerGet("/sprites?max_results=1", org, apiOrigin, token, request);
  if (response.status !== 200) throw new Error("Provider organization cannot be authenticated");
  const result = spriteOrganizationListSchema(org, targetName).safeParse(
    await boundedProviderJson(response),
  );
  if (!result.success) throw new Error("Provider organization mismatch or invalid metadata");
  return result.data;
}
export async function inspectRecoverySprite(
  name: string,
  org: string,
  apiOrigin: string,
  token: string,
  request: RecoveryFetch = fetch,
): Promise<"present" | "missing"> {
  if (!/^civic-spark-[a-z0-9-]{1,45}$/.test(name))
    throw new Error("Invalid recovery reservation name");
  const configuration = [
    process.env.SPRITE_TOKEN,
    process.env.CIVIC_SPARK_SPRITE_ORG,
    process.env.CIVIC_SPARK_SPRITE_API_URL,
  ];
  const checkBinding = () => {
    if (
      configuration.some(
        (value, index) =>
          value !==
          [
            process.env.SPRITE_TOKEN,
            process.env.CIVIC_SPARK_SPRITE_ORG,
            process.env.CIVIC_SPARK_SPRITE_API_URL,
          ][index],
      )
    )
      throw new Error("Provider configuration changed; resource existence remains unknown");
  };
  // Revalidate organization even on a retry; a stale marker is not proof of current absence.
  const organization = await recoveryOrganization(org, apiOrigin, token, request, name);
  checkBinding();
  const response = await providerGet(
    `/sprites/${encodeURIComponent(name)}`,
    org,
    apiOrigin,
    token,
    request,
  );
  checkBinding();
  if (response.status === 404) {
    if (listWitnessesTarget(organization, name))
      throw new Error("Provider resource existence remains unknown");
    return "missing";
  }
  if (response.status !== 200) throw new Error("Provider resource existence remains unknown");
  const resource = spriteResourceCandidateSchema(name, org)
    .extend({ id: z.string().min(1) })
    .safeParse(await boundedProviderJson(response));
  checkBinding();
  if (!resource.success || !resourceAgreesWithWitness(resource.data, organization))
    throw new Error("Provider resource ownership mismatch");
  if (resource.data.organization !== org) {
    const membership = await providerGet(
      spriteMembershipPath(name).slice(3),
      org,
      apiOrigin,
      token,
      request,
    );
    checkBinding();
    const body = membership.status === 200 ? await boundedProviderJson(membership) : null;
    checkBinding();
    if (membership.status !== 200 || !certifiesSpriteResource(body, resource.data, org))
      throw new Error("Provider resource ownership remains unknown");
  }
  return "present";
}

export const resumeSchema = z
  .object({
    target: z.string().min(1),
    installation: installationSchema,
    backupId: z.uuid(),
    spriteOrg: z.string().min(1).nullable(),
    spriteApiOrigin: z.url().default("https://api.sprites.dev"),
    previewBindings: z.record(z.uuid(), z.string()),
    sourceWriterFenced: z.literal(true),
    sharedGitReviewed: z.literal(true),
    previewLedgerComplete: z.literal(true),
    providerActivityReviewed: z.literal(true),
    operatorCredentialsReviewed: z.literal(true),
  })
  .strict();
export type ResumeOptions = z.infer<typeof resumeSchema>;
export async function resumeRestore(
  input: ResumeOptions,
  token = process.env.SPRITE_TOKEN,
  request: RecoveryFetch = fetch,
) {
  const options = resumeSchema.parse(input);
  privateDirectory(options.target);
  const root = join(options.target, "data");
  privateDirectory(root);
  const fencePath = join(root, ".civic-spark-recovery.json");
  const release = acquireWriter(root);
  try {
    const fence = z
      .object({
        version: z.literal(1),
        backupId: z.uuid(),
        installationId: z.string(),
        authMode: z.string(),
        release: z.string(),
        status: z.literal("pending-reconciliation"),
      })
      .parse(JSON.parse(readFileSync(fencePath, "utf8")));
    const manifest = z
      .object({ backupId: z.uuid(), installation: installationSchema })
      .parse(JSON.parse(readFileSync(join(options.target, "manifest.json"), "utf8")));
    if (
      fence.backupId !== options.backupId ||
      manifest.backupId !== options.backupId ||
      JSON.stringify(manifest.installation) !== JSON.stringify(options.installation) ||
      fence.installationId !== options.installation.id ||
      fence.authMode !== options.installation.authMode ||
      fence.release !== options.installation.release
    )
      throw new Error("Recovery installation/release/backup mismatch");
    if (
      manifest.installation.spriteOrg !== options.spriteOrg ||
      manifest.installation.spriteApiOrigin !== options.spriteApiOrigin
    )
      throw new Error("Recovery provider differs from the backed-up installation");
    const active = modeRoot(root, options.installation.authMode);
    const summary = stateInventory(root, options.installation.authMode);
    const path = join(active, "preview-origins.json");
    const old = z
      .record(z.uuid(), z.string())
      .parse(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
    for (const [id, origin] of Object.entries(old))
      if (options.previewBindings[id] !== origin)
        throw new Error("Permanent preview origins cannot be removed or reassigned");
    const hosts = new Set<string>();
    for (const origin of Object.values(options.previewBindings)) {
      validatePreviewOrigin(origin, options.installation.origin);
      const host = new URL(origin).hostname;
      if (hosts.has(host)) throw new Error("Preview origin collision");
      hosts.add(host);
    }
    const entries: RecoveryResources["entries"] = [];
    if (summary.reservations.length) {
      if (!token || !options.spriteOrg)
        throw new Error("Provider token and organization required to reconcile reservations");
      for (const reservation of summary.reservations) {
        const state = await inspectRecoverySprite(
          reservation.spriteName,
          options.spriteOrg,
          options.spriteApiOrigin,
          token,
          request,
        );
        if (state === "missing")
          entries.push({
            workspaceId: reservation.workspaceId,
            spriteName: reservation.spriteName,
            status: "confirmed-missing",
            observedAt: new Date().toISOString(),
            httpStatus: 404,
          });
      }
    }
    const resources: RecoveryResources = {
      version: 1,
      backupId: options.backupId,
      provider: "sprites",
      org: options.spriteOrg ?? "no-sprite-reservations",
      apiOrigin: options.spriteApiOrigin,
      entries,
    };
    // These durable writes precede clearing the fence. Failure/crash is retryable while fenced.
    if (options.spriteOrg)
      replacePrivate(join(active, recoveryResourcesFile), recoveryResourcesSchema.parse(resources));
    replacePrivate(path, options.previewBindings);
    replacePrivate(join(options.target, "RECONCILIATION.json"), {
      ...options,
      completedAt: new Date().toISOString(),
      missing: entries.length,
    });
    rmSync(fencePath);
    syncPath(root);
    return {
      backupId: options.backupId,
      resumed: true,
      missingSprites: entries.length,
      cloudMutations: 0,
    };
  } finally {
    release();
  }
}
