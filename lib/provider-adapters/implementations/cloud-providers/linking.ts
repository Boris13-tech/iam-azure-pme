import { ProviderAdapterError, assertProviderOperationContext, createProviderProjectionEvidence, type ProviderIdentity,
  type ProviderOperationContext, type ProviderProjectionEvidence } from "../..";
import { CLOUD_NORMALIZATION_VERSION } from "./normalization";
import type { CloudProviderType } from "./types";
export type CloudAccountProjection = Readonly<{ identityAccountId: string; subjectId: string; externalObjectId: string;
  providerConnectionId: string; created: boolean; evidence: ProviderProjectionEvidence }>;
export interface CloudAccountProjectionStore { link(context: ProviderOperationContext, input: Readonly<{ providerType: CloudProviderType;
  subjectId: string; externalObjectId: string }>): Promise<Omit<CloudAccountProjection, "evidence">>; }
export interface CloudLinkCollisionStore { quarantine(context: ProviderOperationContext, input: Readonly<{ externalObjectId: string;
  candidateSubjectIds: ReadonlyArray<string>; reasonCode: "AMBIGUOUS_SUBJECT_MAPPING" }>): Promise<void>; }
export async function linkCloudProjection(input: Readonly<{ context: ProviderOperationContext; providerType: CloudProviderType;
  identity: ProviderIdentity; candidateSubjectIds: ReadonlyArray<string> }>, store: CloudAccountProjectionStore,
  collisions: CloudLinkCollisionStore): Promise<CloudAccountProjection> {
  assertProviderOperationContext(input.context); const candidates = [...new Set(input.candidateSubjectIds.filter((x) => x.trim()))].sort();
  if (candidates.length !== 1) { await collisions.quarantine(input.context, { externalObjectId: input.identity.ref.externalObjectId,
    candidateSubjectIds: candidates, reasonCode: "AMBIGUOUS_SUBJECT_MAPPING" });
    throw new ProviderAdapterError({ code: "CONFLICT", message: "Cloud identity mapping is ambiguous",
      safeDetails: { reason: "AMBIGUOUS_SUBJECT_MAPPING", candidates: candidates.length } }); }
  const linked = await store.link(input.context, { providerType: input.providerType, subjectId: candidates[0],
    externalObjectId: input.identity.ref.externalObjectId });
  return Object.freeze({ ...linked, evidence: createProviderProjectionEvidence({ context: input.context, providerType: input.providerType,
    eventType: "LINKED", identity: input.identity, normalizationVersion: CLOUD_NORMALIZATION_VERSION, subjectId: linked.subjectId }) });
}
