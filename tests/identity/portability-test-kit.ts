import type { BackupKeyCustody, SovereignIdentityContentV1 } from "../../lib/identity";
import { scope } from "./continuity-test-kit";

export const portableContent = (): SovereignIdentityContentV1 => ({
  subjects: [{ id: "subject-alice", type: "HUMAN", lifecycleState: "ACTIVE", lifecycleVersion: 7, displayName: "Alice" }],
  providerConnections: [{ id: "entra-old", providerType: "MICROSOFT_ENTRA", externalScopeId: "external-tenant" }],
  identityAccounts: [{ id: "account-alice", subjectId: "subject-alice", providerConnectionId: "entra-old", externalObjectId: "external-alice" }],
  resources: [{ id: "resource-a", name: "Finance", type: "APPLICATION", providerConnectionId: "entra-old" }],
  entitlements: [{ id: "entitlement-reader", key: "finance.read", action: "read", resource: "finance" }],
  credentials: [
    { id: "passkey-a", subjectId: "subject-alice", identityAccountId: "account-alice", type: "PASSKEY", status: "ACTIVE",
      formatVersion: 2, stateVersion: 4, algorithmId: "WEBAUTHN_ES256", algorithmVersion: 1, keyId: "key-public-a", keyVersion: 2,
      deviceBound: true, exportability: "REENROLLMENT_REQUIRED", publicMaterial: "public-key-only" },
    { id: "revoked-a", subjectId: "subject-alice", identityAccountId: "account-alice", type: "PASSKEY", status: "REVOKED",
      formatVersion: 2, stateVersion: 5, algorithmId: "WEBAUTHN_ES256", algorithmVersion: 1,
      deviceBound: true, exportability: "REENROLLMENT_REQUIRED" },
  ],
  assignments: [{ id: "assignment-a", subjectId: "subject-alice", entitlementId: "entitlement-reader", source: "DIRECT", status: "ACTIVE" }],
  evidenceReferences: [{ id: "evidence-a", subjectId: "subject-alice", evidenceType: "AUTHENTICATION", evidenceVersion: 1,
    provenanceDigest: "sha256:evidence-provenance", issuedAt: "2026-09-23T12:00:00.000Z" }],
  assuranceReferences: [{ id: "snapshot-a", subjectId: "subject-alice", assuranceProfile: "passkey", assuranceLevel: "HIGH",
    evidenceDigest: "sha256:evidence", recoveryEpoch: 4, expiresAt: "2026-09-24T12:00:00.000Z" }],
  trustAnchors: [{ id: "anchor-a-v1", logicalAnchorId: "anchor-a", version: 1, algorithmId: "SHA256",
    algorithmVersion: 1, status: "VERIFY_ONLY", publicMaterial: "public-anchor" }],
  keyMetadata: [{ id: "key-a-v1", logicalKeyId: "key-a", version: 1, purpose: "EVIDENCE_SIGNATURE",
    algorithmId: "EVIDENCE_ES256", algorithmVersion: 1, status: "VERIFY_ONLY" }],
});

export class MemoryBackupCustody implements BackupKeyCustody {
  constructor(private readonly key = Buffer.alloc(32, 7)) {}
  async withKey<T>(requested: typeof scope, keyRef: string, operation: (key: Uint8Array) => T): Promise<T> {
    if (requested.organizationId !== scope.organizationId || requested.tenantId !== scope.tenantId || keyRef !== "custody://backup/key-1")
      throw new Error("KEY_UNAVAILABLE");
    return operation(Uint8Array.from(this.key));
  }
}
