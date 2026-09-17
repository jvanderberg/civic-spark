import { createHash } from "node:crypto";
import type { SpriteCreationFailure } from "../../domain/src/provisioning.ts";

type Stage = "headers" | "body" | "validation" | "complete";
type FieldType = "absent" | "null" | "array" | "object" | "string" | "number" | "boolean";
export type SpriteCreateDiagnostic = {
  event: "sprite.create";
  reservationHash: string;
  requireMissing: boolean;
  httpStatus: number | null;
  durationMs: number;
  headersElapsedMs: number | null;
  bodyElapsedMs: number | null;
  validationElapsedMs: number | null;
  abortElapsedMs: number | null;
  abortKind: "timeout" | "lease" | "other" | null;
  abortStage: Stage | null;
  stage: Stage;
  confirmed: boolean;
  creationFailure: SpriteCreationFailure | null;
  response: {
    bodyType: FieldType;
    idType: FieldType;
    nameType: FieldType;
    organizationType: FieldType;
    orgSlugType: FieldType;
    nameMatches: boolean;
    organizationMatchesOrg: boolean;
    organizationMatchesAccount: boolean;
    orgSlugMatchesOrg: boolean;
    orgSlugMatchesAccount: boolean;
  } | null;
};
export type SpriteCreateLogger = (diagnostic: SpriteCreateDiagnostic) => void;
export const logSpriteCreate: SpriteCreateLogger = (diagnostic) => {
  console.info(JSON.stringify(diagnostic));
};

function fieldType(value: unknown): FieldType {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return typeof value as "string" | "number" | "boolean";
  return "object";
}

/** Only fixed fields/types/booleans leave this observer; no raw provider data or credentials. */
export function observeSpriteCreate(
  name: string,
  org: string,
  account: string,
  requireMissing: boolean,
  logger: SpriteCreateLogger,
) {
  const started = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));
  const record: SpriteCreateDiagnostic = {
    event: "sprite.create",
    reservationHash: createHash("sha256").update(name).digest("hex"),
    requireMissing,
    httpStatus: null,
    durationMs: 0,
    headersElapsedMs: null,
    bodyElapsedMs: null,
    validationElapsedMs: null,
    abortElapsedMs: null,
    abortKind: null,
    abortStage: null,
    stage: "headers",
    confirmed: false,
    creationFailure: null,
    response: null,
  };
  return {
    headers(status: number) {
      record.httpStatus = status;
      record.headersElapsedMs = elapsed();
      record.stage = "body";
    },
    body(body: unknown) {
      const value =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {};
      record.response = {
        bodyType: fieldType(body),
        idType: fieldType(value.id),
        nameType: fieldType(value.name),
        organizationType: fieldType(value.organization),
        orgSlugType: fieldType(value.org_slug),
        nameMatches: value.name === name,
        organizationMatchesOrg: value.organization === org,
        organizationMatchesAccount: value.organization === account,
        orgSlugMatchesOrg: value.org_slug === org,
        orgSlugMatchesAccount: value.org_slug === account,
      };
      record.bodyElapsedMs = elapsed();
      record.stage = "validation";
    },
    validated(confirmed: boolean) {
      record.confirmed = confirmed;
      record.validationElapsedMs = elapsed();
      record.stage = "complete";
    },
    aborted(kind: NonNullable<SpriteCreateDiagnostic["abortKind"]>) {
      record.abortElapsedMs = elapsed();
      record.abortKind = kind;
      record.abortStage = record.stage;
    },
    finish(failure: SpriteCreationFailure | null) {
      record.durationMs = elapsed();
      record.creationFailure = failure;
      try {
        logger(record);
      } catch {
        // An unavailable diagnostic sink must never change creation or trigger retry.
      }
    },
  };
}
