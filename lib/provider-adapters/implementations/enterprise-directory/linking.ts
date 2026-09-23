import { ProviderAdapterError, assertProviderOperationContext, type ExternalIdentityRef, type ProviderOperationContext } from "../..";

export type DirectoryAccountProjection = Readonly<{ identityAccountId: string; subjectId: string; externalObjectId: string;
  providerConnectionId: string; created: boolean }>;
export interface DirectoryAccountProjectionStore {
  link(context: ProviderOperationContext, input: Readonly<{ providerType: "LDAP" | "ACTIVE_DIRECTORY" | "SAMBA_AD";
    subjectId: string; externalObjectId: string }>): Promise<DirectoryAccountProjection>;
}
export interface DirectoryLinkCollisionStore {
  quarantine(context: ProviderOperationContext, input: Readonly<{ externalObjectId: string; candidateSubjectIds: ReadonlyArray<string>;
    reasonCode: "AMBIGUOUS_SUBJECT_MAPPING" }>): Promise<void>;
}

export async function linkDirectoryProjection(input: Readonly<{ context: ProviderOperationContext;
  providerType: "LDAP" | "ACTIVE_DIRECTORY" | "SAMBA_AD"; identity: ExternalIdentityRef;
  candidateSubjectIds: ReadonlyArray<string> }>, store: DirectoryAccountProjectionStore,
  collisions: DirectoryLinkCollisionStore): Promise<DirectoryAccountProjection> {
  assertProviderOperationContext(input.context);
  const candidates = [...new Set(input.candidateSubjectIds.filter((value) => value.trim()))].sort();
  if (candidates.length !== 1) {
    await collisions.quarantine(input.context, { externalObjectId: input.identity.externalObjectId,
      candidateSubjectIds: candidates, reasonCode: "AMBIGUOUS_SUBJECT_MAPPING" });
    throw new ProviderAdapterError({ code: "CONFLICT", message: "Directory identity mapping is ambiguous",
      safeDetails: { reason: "AMBIGUOUS_SUBJECT_MAPPING", candidates: candidates.length } });
  }
  return store.link(input.context, { providerType: input.providerType, subjectId: candidates[0],
    externalObjectId: input.identity.externalObjectId.toLowerCase() });
}
