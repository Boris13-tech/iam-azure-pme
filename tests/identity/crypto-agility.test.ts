import { describe, expect, it } from "vitest";
import {
  CryptoAlgorithmRegistry,
  CryptoPolicyError,
  LUXIA_CRYPTO_ALGORITHMS,
  assertKeyLifecycleTransition,
  assertCredentialLifecycleTransition,
  assessHistoricalEvidenceCompatibility,
  createAuthenticationEvidence,
  planCredentialUpgrade,
  planKeyRotation,
  planTrustAnchorRotation,
  type CredentialDescriptorV1,
  type CredentialDescriptorV2,
  type VersionedKeyDescriptor,
} from "../../lib/identity";

const key = (status: VersionedKeyDescriptor["status"] = "ACTIVE", version = 1): VersionedKeyDescriptor => ({
  logicalKeyId: "evidence-key", version, purpose: "EVIDENCE_SIGNATURE",
  algorithmId: "EVIDENCE_ES256", algorithmVersion: 1, status,
});

const evidence = (withCrypto = true) => createAuthenticationEvidence({
  organizationId: "org", tenantId: "tenant", providerConnectionId: "provider",
  subjectId: "subject", identityAccountId: "account", externalObjectId: "external",
  method: "PASSKEY", reasonCode: "VERIFIED",
  assurance: { level: "SUBSTANTIAL", profile: "local-passkey", profileVersion: 1, phishingResistant: true, hardwareBound: true, userVerification: "VERIFIED" },
  provenance: { schemaVersion: 1, source: "LOCAL_VERIFIER", sourceRef: "LUXIA_LOCAL", verifierPolicyVersion: 1,
    operationId: "operation", occurredAt: "2026-09-23T00:00:00.000Z", offline: true,
    ...(withCrypto ? { algorithmId: "EVIDENCE_ES256", algorithmVersion: 1, keyId: "evidence-key", keyVersion: "1" } : {}) },
});

describe("Phase 6E crypto policy", () => {
  it("fails closed for unknown versions, disabled algorithms and purpose mismatches", () => {
    expect(() => LUXIA_CRYPTO_ALGORITHMS.resolve("UNKNOWN", 1, "TOTP", "VERIFY")).toThrowError(CryptoPolicyError);
    expect(() => LUXIA_CRYPTO_ALGORITHMS.resolve("WEBAUTHN_ES256", 2, "WEBAUTHN_ASSERTION", "VERIFY")).toThrow("UNSUPPORTED_CRYPTO_VERSION");
    expect(() => LUXIA_CRYPTO_ALGORITHMS.resolve("TOTP_HMAC_SHA1", 1, "EVIDENCE_SIGNATURE", "VERIFY")).toThrow("CRYPTO_PURPOSE_MISMATCH");
    const registry = new CryptoAlgorithmRegistry([{ id: "OLD", version: 1, purposes: new Set(["TOTP"]), status: "VERIFY_ONLY" }]);
    expect(registry.resolve("OLD", 1, "TOTP", "VERIFY").status).toBe("VERIFY_ONLY");
    expect(() => registry.resolve("OLD", 1, "TOTP", "CREATE")).toThrow("CRYPTO_DISABLED");
  });

  it("rotates an active key while retaining the previous version for verification", () => {
    const result = planKeyRotation(key(), key("PENDING", 2));
    expect(result.previous).toMatchObject({ version: 1, status: "VERIFY_ONLY" });
    expect(result.next).toMatchObject({ version: 2, status: "ACTIVE" });
    expect(() => planKeyRotation(key(), key("PENDING", 1))).toThrow("INVALID_KEY_ROTATION");
    expect(() => assertKeyLifecycleTransition("COMPROMISED", "ACTIVE")).toThrow("INVALID_KEY_ROTATION");
    expect(() => assertKeyLifecycleTransition("REVOKED", "RETIRED")).not.toThrow();
    expect(() => planTrustAnchorRotation(
      { trustAnchorId: "root", version: 1, algorithmId: "SHA256", algorithmVersion: 1, status: "ACTIVE" },
      { trustAnchorId: "root", version: 2, algorithmId: "SHA256", algorithmVersion: 1, status: "PENDING" },
    )).not.toThrow();
  });

  it("upgrades a legacy credential additively and preserves device binding semantics", () => {
    const current: CredentialDescriptorV1 = { schemaVersion: 1, credentialId: "old", subjectId: "human", identityAccountId: "account",
      type: "PASSKEY", format: "WEBAUTHN_PUBLIC_KEY", formatVersion: 1, status: "ACTIVE", verifierPolicyVersion: 1,
      hardwareBound: false, exportability: "PUBLIC_ONLY" };
    const replacement: CredentialDescriptorV2 = { schemaVersion: 2, credentialId: "next", subjectId: "human", identityAccountId: "account",
      type: "PASSKEY", format: "WEBAUTHN_PUBLIC_KEY", formatVersion: 2, status: "PENDING",
      crypto: { algorithmId: "WEBAUTHN_ES256", algorithmVersion: 1, verifierPolicyVersion: 2 },
      deviceBinding: { deviceSubjectId: "device", bindingType: "PLATFORM_BOUND", bindingVersion: 1 },
      exportability: "NON_EXPORTABLE", supersedesCredentialId: "old" };
    expect(planCredentialUpgrade(current, replacement)).toEqual({ previousCredentialId: "old", nextCredentialId: "next", previousStatus: "SUPERSEDED", nextStatus: "ACTIVE" });
    expect(() => planCredentialUpgrade(current, { ...replacement, subjectId: "other" })).toThrow("INVALID_CREDENTIAL_UPGRADE");
    expect(() => assertCredentialLifecycleTransition("ACTIVE", "COMPROMISED")).not.toThrow();
    expect(() => assertCredentialLifecycleTransition("COMPROMISED", "ACTIVE")).toThrow("INVALID_CREDENTIAL_UPGRADE");
  });

  it("keeps old evidence classifiable after rotation and makes revocation/compromise explicit", () => {
    expect(assessHistoricalEvidenceCompatibility(evidence(false))).toBe("LEGACY_COMPATIBLE");
    expect(assessHistoricalEvidenceCompatibility(evidence(), key())).toBe("CURRENT_KEY");
    expect(assessHistoricalEvidenceCompatibility(evidence(), key("VERIFY_ONLY"))).toBe("ROTATED_KEY_VERIFY_ONLY");
    expect(assessHistoricalEvidenceCompatibility(evidence(), key("RETIRED"))).toBe("RETIRED_KEY_HISTORICAL");
    expect(assessHistoricalEvidenceCompatibility(evidence(), key("REVOKED"))).toBe("KEY_REVOKED");
    expect(assessHistoricalEvidenceCompatibility(evidence(), key("COMPROMISED"))).toBe("KEY_COMPROMISED");
  });
});
