import { createHash } from "node:crypto";
import { assertProviderOperationContext, type ProviderIdentity, type ProviderOperationContext,
  type ProviderProjectionEvidence, type ProviderTypeId } from "./types";

export function createProviderProjectionEvidence(input: Readonly<{ context: ProviderOperationContext; providerType: ProviderTypeId;
  eventType: "DISCOVERED" | "LINKED"; identity: ProviderIdentity; normalizationVersion: number; subjectId?: string;
  occurredAt?: string }>): ProviderProjectionEvidence {
  assertProviderOperationContext(input.context);
  if (!input.providerType.trim() || input.normalizationVersion < 1 || !Number.isInteger(input.normalizationVersion))
    throw new Error("INVALID_PROJECTION_EVIDENCE");
  return Object.freeze({ schemaVersion: 1, eventType: input.eventType, ...input.context, providerType: input.providerType,
    externalObjectIdDigest: digest(input.identity.ref.externalObjectId), projectionDigest: digest(stable(input.identity)),
    normalizationVersion: input.normalizationVersion, occurredAt: input.occurredAt ?? new Date().toISOString(),
    ...(input.subjectId ? { subjectId: input.subjectId } : {}) });
}
function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("base64url")}`; }
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}
