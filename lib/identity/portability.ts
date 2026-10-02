import { randomUUID } from "node:crypto";
import { LUXIA_CRYPTO_ALGORITHMS } from "./crypto-agility";
import { canonicalBytes, continuityDigest, type ContinuitySignatureProvider, type DetachedContinuitySignature } from "./continuity";
import type { ContinuityScope } from "./continuity-store";

export class PortabilitySecurityError extends Error {
  constructor(readonly code: "INVALID_SCOPE" | "INVALID_FORMAT" | "INTEGRITY_FAILURE" | "SIGNATURE_INVALID" |
    "STALE_RECOVERY_EPOCH" | "RECOVERY_REPLAY" | "CONFLICT_QUARANTINED" | "SECRET_MATERIAL_FORBIDDEN") {
    super(code); this.name = "PortabilitySecurityError";
  }
}

export type PortableSubject = Readonly<{ id: string; type: "HUMAN" | "DEVICE" | "WORKLOAD" | "SERVICE" | "AI_AGENT";
  lifecycleState: string; lifecycleVersion: number; displayName?: string }>;
export type PortableProviderConnection = Readonly<{ id: string; providerType: string; externalScopeId?: string }>;
export type PortableIdentityAccount = Readonly<{ id: string; subjectId: string; providerConnectionId: string; externalObjectId: string }>;
export type PortableResource = Readonly<{ id: string; name: string; type: string; providerConnectionId?: string; externalId?: string }>;
export type PortableEntitlement = Readonly<{ id: string; key: string; action: string; resource: string }>;
export type PortableCredential = Readonly<{ id: string; subjectId: string; identityAccountId: string; type: string; status: string;
  formatVersion: number; stateVersion: number; algorithmId: string; algorithmVersion: number; keyId?: string; keyVersion?: number;
  trustAnchorId?: string; deviceBound: boolean; exportability: "PUBLIC_METADATA_ONLY" | "REENROLLMENT_REQUIRED";
  publicMaterial?: string }>;
export type PortableAssignment = Readonly<{ id: string; subjectId: string; entitlementId: string; source: string; sourceRef?: string;
  status: string; validFrom?: string; validUntil?: string }>;
export type PortableEvidenceReference = Readonly<{ id: string; subjectId: string; evidenceType: string; evidenceVersion: number;
  provenanceDigest: string; issuedAt: string }>;
export type PortableAssuranceReference = Readonly<{ id: string; subjectId: string; assuranceProfile: string; assuranceLevel: string;
  evidenceDigest: string; recoveryEpoch: number; expiresAt: string; revokedAt?: string }>;
export type PortableTrustAnchor = Readonly<{ id: string; logicalAnchorId: string; version: number; algorithmId: string;
  algorithmVersion: number; status: string; publicMaterial: string }>;
export type PortableKeyMetadata = Readonly<{ id: string; logicalKeyId: string; version: number; purpose: string;
  algorithmId: string; algorithmVersion: number; status: string }>;

export type SovereignIdentityContentV1 = Readonly<{
  subjects: ReadonlyArray<PortableSubject>;
  providerConnections: ReadonlyArray<PortableProviderConnection>;
  identityAccounts: ReadonlyArray<PortableIdentityAccount>;
  resources: ReadonlyArray<PortableResource>;
  entitlements: ReadonlyArray<PortableEntitlement>;
  credentials: ReadonlyArray<PortableCredential>;
  assignments: ReadonlyArray<PortableAssignment>;
  evidenceReferences: ReadonlyArray<PortableEvidenceReference>;
  assuranceReferences: ReadonlyArray<PortableAssuranceReference>;
  trustAnchors: ReadonlyArray<PortableTrustAnchor>;
  keyMetadata: ReadonlyArray<PortableKeyMetadata>;
}>;
export type SovereignRecoveryManifestV1 = Readonly<{
  format: "LUXIA_SOVEREIGN_IDENTITY"; formatVersion: 1; packageId: string; organizationId: string; tenantId: string;
  recoveryEpoch: number; sourceDeploymentId: string; createdAt: string; contentDigest: string;
  sections: Readonly<Record<keyof SovereignIdentityContentV1, Readonly<{ count: number; digest: string }>>>;
}>;
export type SovereignIdentityPackageV1 = Readonly<{
  manifest: SovereignRecoveryManifestV1; content: SovereignIdentityContentV1; signature: DetachedContinuitySignature;
}>;

export async function createSovereignExport(input: Readonly<{ scope: ContinuityScope; recoveryEpoch: number;
  sourceDeploymentId: string; content: SovereignIdentityContentV1; now?: Date; packageId?: string }>,
  signer: ContinuitySignatureProvider): Promise<SovereignIdentityPackageV1> {
  assertScope(input.scope); safeEpoch(input.recoveryEpoch); required(input.sourceDeploymentId);
  const content = normalizeAndValidateContent(input.content);
  const manifest: SovereignRecoveryManifestV1 = Object.freeze({ format: "LUXIA_SOVEREIGN_IDENTITY", formatVersion: 1,
    packageId: input.packageId ?? randomUUID(), ...input.scope, recoveryEpoch: input.recoveryEpoch,
    sourceDeploymentId: input.sourceDeploymentId, createdAt: (input.now ?? new Date()).toISOString(),
    contentDigest: continuityDigest(content), sections: sectionManifest(content) });
  const signature = await signer.sign(canonicalBytes(manifest), "RECOVERY_MANIFEST");
  validateManifestSignature(signature);
  return Object.freeze({ manifest, content, signature });
}

export async function verifySovereignExport(pkg: SovereignIdentityPackageV1, expected: Readonly<{ scope: ContinuityScope;
  recoveryEpoch: number; seenPackageIds?: ReadonlySet<string> }>, verifier: ContinuitySignatureProvider): Promise<SovereignIdentityPackageV1> {
  if (pkg.manifest.format !== "LUXIA_SOVEREIGN_IDENTITY" || pkg.manifest.formatVersion !== 1) fail("INVALID_FORMAT");
  if (pkg.manifest.organizationId !== expected.scope.organizationId || pkg.manifest.tenantId !== expected.scope.tenantId) fail("INVALID_SCOPE");
  if (pkg.manifest.recoveryEpoch !== expected.recoveryEpoch) fail("STALE_RECOVERY_EPOCH");
  if (expected.seenPackageIds?.has(pkg.manifest.packageId)) fail("RECOVERY_REPLAY");
  const content = normalizeAndValidateContent(pkg.content);
  if (continuityDigest(content) !== pkg.manifest.contentDigest || !sectionsMatch(pkg.manifest.sections, content)) fail("INTEGRITY_FAILURE");
  validateManifestSignature(pkg.signature);
  if (!await verifier.verify(canonicalBytes(pkg.manifest), pkg.signature, "RECOVERY_MANIFEST")) fail("SIGNATURE_INVALID");
  return Object.freeze({ manifest: pkg.manifest, content, signature: pkg.signature });
}

function normalizeAndValidateContent(value: SovereignIdentityContentV1): SovereignIdentityContentV1 {
  rejectSecretMaterial(value);
  const content = Object.freeze({ subjects: sortedUnique(value.subjects), providerConnections: sortedUnique(value.providerConnections),
    identityAccounts: sortedUnique(value.identityAccounts), resources: sortedUnique(value.resources),
    entitlements: sortedUnique(value.entitlements), credentials: sortedUnique(value.credentials),
    assignments: sortedUnique(value.assignments), evidenceReferences: sortedUnique(value.evidenceReferences),
    assuranceReferences: sortedUnique(value.assuranceReferences), trustAnchors: sortedUnique(value.trustAnchors),
    keyMetadata: sortedUnique(value.keyMetadata) });
  const subjectIds = new Set(content.subjects.map((x) => x.id));
  const connectionIds = new Set(content.providerConnections.map((x) => x.id));
  const accountIds = new Set(content.identityAccounts.map((x) => x.id));
  const entitlementIds = new Set(content.entitlements.map((x) => x.id));
  for (const item of content.identityAccounts) if (!subjectIds.has(item.subjectId) || !connectionIds.has(item.providerConnectionId)) fail("INTEGRITY_FAILURE");
  for (const item of content.resources) if (item.providerConnectionId && !connectionIds.has(item.providerConnectionId)) fail("INTEGRITY_FAILURE");
  for (const item of content.credentials) {
    if (!subjectIds.has(item.subjectId) || !accountIds.has(item.identityAccountId) || item.formatVersion < 1 || item.stateVersion < 0) fail("INTEGRITY_FAILURE");
    if (item.status === "REVOKED" && item.exportability !== "REENROLLMENT_REQUIRED") fail("INTEGRITY_FAILURE");
  }
  for (const item of content.assignments) if (!subjectIds.has(item.subjectId) || !entitlementIds.has(item.entitlementId)) fail("INTEGRITY_FAILURE");
  for (const item of content.evidenceReferences) if (!subjectIds.has(item.subjectId) || !item.provenanceDigest.startsWith("sha256:")) fail("INTEGRITY_FAILURE");
  for (const item of content.assuranceReferences) if (!subjectIds.has(item.subjectId) || !item.evidenceDigest.startsWith("sha256:") || item.recoveryEpoch < 0) fail("INTEGRITY_FAILURE");
  return content;
}
function sortedUnique<T extends { id: string }>(items: ReadonlyArray<T>): ReadonlyArray<T> {
  const ids = new Set<string>(); const output = [...items].sort((a, b) => a.id.localeCompare(b.id));
  for (const item of output) { required(item.id); if (ids.has(item.id)) fail("CONFLICT_QUARANTINED"); ids.add(item.id); }
  return Object.freeze(output.map((item) => Object.freeze({ ...item })));
}
function sectionManifest(content: SovereignIdentityContentV1): SovereignRecoveryManifestV1["sections"] {
  return Object.freeze(Object.fromEntries(Object.entries(content).map(([name, items]) =>
    [name, Object.freeze({ count: items.length, digest: continuityDigest(items) })])) as SovereignRecoveryManifestV1["sections"]);
}
function sectionsMatch(sections: SovereignRecoveryManifestV1["sections"], content: SovereignIdentityContentV1): boolean {
  const expected = sectionManifest(content);
  return (Object.keys(expected) as Array<keyof SovereignIdentityContentV1>).every((key) =>
    sections[key]?.count === expected[key].count && sections[key]?.digest === expected[key].digest);
}
function rejectSecretMaterial(value: unknown, path = "root"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(private.?key|secret|password|totp.?seed|custody.?ref)/i.test(key)) fail("SECRET_MATERIAL_FORBIDDEN");
    if (typeof child === "object") rejectSecretMaterial(child, `${path}.${key}`);
  }
}
function validateManifestSignature(value: DetachedContinuitySignature): void {
  try { LUXIA_CRYPTO_ALGORITHMS.resolve(value.algorithmId, value.algorithmVersion, "RECOVERY_MANIFEST", "VERIFY"); }
  catch { fail("SIGNATURE_INVALID"); }
  if (value.keyVersion < 1 || !value.keyId || !value.value) fail("SIGNATURE_INVALID");
}
function assertScope(scope: ContinuityScope): void { required(scope.organizationId); required(scope.tenantId); }
function required(value: string): void { if (!value.trim()) fail("INVALID_FORMAT"); }
function safeEpoch(value: number): void { if (!Number.isSafeInteger(value) || value < 0) fail("STALE_RECOVERY_EPOCH"); }
function fail(code: PortabilitySecurityError["code"]): never { throw new PortabilitySecurityError(code); }
