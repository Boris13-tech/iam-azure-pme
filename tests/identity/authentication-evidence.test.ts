import { describe, expect, it } from "vitest";
import { createAuthenticationEvidence } from "../../lib/identity";

describe("Phase 6D authentication assurance evidence", () => {
  it("creates versioned provider-neutral evidence with scoped provenance", () => {
    const evidence = createAuthenticationEvidence({
      organizationId: "org-a",
      tenantId: "tenant-a",
      providerConnectionId: "connection-a",
      subjectId: "subject-a",
      identityAccountId: "account-a",
      externalObjectId: "opaque-provider-object",
      method: "PASSKEY",
      reasonCode: "LOCAL_PASSKEY_ASSERTION_VERIFIED",
      assurance: {
        level: "HIGH", profile: "phishing-resistant", profileVersion: 2,
        phishingResistant: true, hardwareBound: true, userVerification: "VERIFIED",
      },
      provenance: {
        schemaVersion: 1, source: "LOCAL_VERIFIER", sourceRef: "LUXIA_LOCAL",
        verifierPolicyVersion: 3, operationId: "operation-a",
        occurredAt: "2026-09-23T00:00:00.000Z", algorithmId: "ES256",
        keyVersion: "4", evidenceDigest: "sha256:digest", offline: true, partitionEpoch: "7",
      },
    });
    expect(evidence).toMatchObject({ evidenceType: "AUTHENTICATION", outcome: "VERIFIED", method: "PASSKEY" });
    expect(evidence.evidenceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(evidence)).not.toMatch(/accessToken|idToken|refreshToken|password/i);
  });

  it("rejects missing provenance and invalid semantic versions", () => {
    const base = {
      organizationId: "org-a", tenantId: "tenant-a", providerConnectionId: "connection-a",
      externalObjectId: "external-a", method: "FEDERATED_OIDC" as const,
      reasonCode: "OIDC_VERIFIED",
      assurance: { level: "LOW" as const, profile: "oidc", profileVersion: 1, phishingResistant: false, hardwareBound: false, userVerification: "PROVIDER_ASSERTED" as const },
      provenance: { schemaVersion: 1 as const, source: "EXTERNAL_PROVIDER" as const, sourceRef: "", verifierPolicyVersion: 1, operationId: "op", occurredAt: "2026-09-23T00:00:00.000Z", offline: false },
    };
    expect(() => createAuthenticationEvidence(base)).toThrow("INVALID_AUTHENTICATION_EVIDENCE");
    expect(() => createAuthenticationEvidence({ ...base, provenance: { ...base.provenance, sourceRef: "provider", verifierPolicyVersion: 0 } })).toThrow("INVALID_AUTHENTICATION_EVIDENCE_VERSION");
  });
});
