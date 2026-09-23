import { continuityDigest } from "./continuity";
import { PortabilitySecurityError, type SovereignIdentityPackageV1 } from "./portability";

export type ProviderReplacement = Readonly<{ sourceProviderConnectionId: string; targetProviderConnectionId: string }>;
export type PortabilityImportAction = Readonly<{ entityType: string; entityId: string;
  action: "CREATE" | "SKIP_IDENTICAL" | "REMAP_PROVIDER" | "PRESERVE_REVOKED" | "REQUIRE_REENROLLMENT" | "QUARANTINE";
  reasonCode: string; targetProviderConnectionId?: string }>;
export type PortabilityImportPlan = Readonly<{ packageId: string; organizationId: string; tenantId: string; recoveryEpoch: number;
  targetDeploymentId: string; isolatedEnvironment: true; actions: ReadonlyArray<PortabilityImportAction>;
  conflicts: ReadonlyArray<PortabilityImportAction>; deterministicDigest: string }>;

export function planSovereignImport(input: Readonly<{ pkg: SovereignIdentityPackageV1; targetDeploymentId: string;
  isolatedEnvironment: boolean; currentRecoveryEpoch: number; seenPackageIds?: ReadonlySet<string>;
  existingEntityDigests?: ReadonlyMap<string, string>; providerReplacements?: ReadonlyArray<ProviderReplacement> }>): PortabilityImportPlan {
  if (!input.isolatedEnvironment) throw new PortabilitySecurityError("INVALID_SCOPE");
  if (input.currentRecoveryEpoch !== input.pkg.manifest.recoveryEpoch) throw new PortabilitySecurityError("STALE_RECOVERY_EPOCH");
  if (input.seenPackageIds?.has(input.pkg.manifest.packageId)) throw new PortabilitySecurityError("RECOVERY_REPLAY");
  const replacements = new Map((input.providerReplacements ?? []).map((x) => [x.sourceProviderConnectionId, x.targetProviderConnectionId]));
  if (replacements.size !== (input.providerReplacements ?? []).length) throw new PortabilitySecurityError("CONFLICT_QUARANTINED");
  const actions: PortabilityImportAction[] = [];
  const add = (type: string, entity: { id: string }, extra?: Partial<PortabilityImportAction>) => {
    const key = `${type}:${entity.id}`; const incoming = continuityDigest(entity); const existing = input.existingEntityDigests?.get(key);
    if (existing && existing !== incoming) actions.push({ entityType: type, entityId: entity.id, action: "QUARANTINE", reasonCode: "DUPLICATE_ID_DIFFERENT_CONTENT" });
    else actions.push({ entityType: type, entityId: entity.id, action: existing ? "SKIP_IDENTICAL" : "CREATE", reasonCode: existing ? "IDEMPOTENT_MATCH" : "NEW_ENTITY", ...extra });
  };
  for (const item of input.pkg.content.subjects) add("SUBJECT", item);
  for (const item of input.pkg.content.providerConnections) add("PROVIDER_CONNECTION", item,
    replacements.has(item.id) ? { action: "REMAP_PROVIDER", reasonCode: "PROVIDER_REPLACED_WITHOUT_IDENTITY_CHANGE",
      targetProviderConnectionId: replacements.get(item.id) } : undefined);
  for (const item of input.pkg.content.identityAccounts) add("IDENTITY_ACCOUNT", item,
    replacements.has(item.providerConnectionId) ? { action: "REMAP_PROVIDER", reasonCode: "PROVIDER_PROJECTION_REMAPPED",
      targetProviderConnectionId: replacements.get(item.providerConnectionId) } : undefined);
  for (const item of input.pkg.content.resources) add("RESOURCE", item,
    item.providerConnectionId && replacements.has(item.providerConnectionId) ? { action: "REMAP_PROVIDER", reasonCode: "RESOURCE_PROVIDER_REMAPPED",
      targetProviderConnectionId: replacements.get(item.providerConnectionId) } : undefined);
  for (const item of input.pkg.content.entitlements) add("ENTITLEMENT", item);
  for (const item of input.pkg.content.credentials) {
    if (item.status === "REVOKED" || item.status === "COMPROMISED") actions.push({ entityType: "CREDENTIAL", entityId: item.id,
      action: "PRESERVE_REVOKED", reasonCode: "RESTRICTIVE_CREDENTIAL_STATE_PRESERVED" });
    else if (item.exportability === "REENROLLMENT_REQUIRED") actions.push({ entityType: "CREDENTIAL", entityId: item.id,
      action: "REQUIRE_REENROLLMENT", reasonCode: "NON_EXPORTABLE_AUTHENTICATOR" });
    else add("CREDENTIAL", item);
  }
  for (const item of input.pkg.content.assignments) add("ASSIGNMENT", item);
  for (const item of input.pkg.content.evidenceReferences) add("EVIDENCE_REFERENCE", item);
  for (const item of input.pkg.content.assuranceReferences) add("ASSURANCE_REFERENCE", item);
  for (const item of input.pkg.content.trustAnchors) add("TRUST_ANCHOR", item);
  for (const item of input.pkg.content.keyMetadata) add("KEY_METADATA", item);
  const normalized = actions.sort((a, b) => `${a.entityType}:${a.entityId}:${a.action}`.localeCompare(`${b.entityType}:${b.entityId}:${b.action}`));
  const conflicts = normalized.filter((x) => x.action === "QUARANTINE");
  const base = { packageId: input.pkg.manifest.packageId, organizationId: input.pkg.manifest.organizationId,
    tenantId: input.pkg.manifest.tenantId, recoveryEpoch: input.currentRecoveryEpoch,
    targetDeploymentId: input.targetDeploymentId, isolatedEnvironment: true as const, actions: normalized, conflicts };
  return Object.freeze({ ...base, deterministicDigest: continuityDigest(base) });
}
