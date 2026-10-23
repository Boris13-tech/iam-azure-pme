// Security Journal v1 (docs/product/SECURITY-JOURNAL-V1-SCOPE.md): sign-in evidence records.
// Decision S1: a Microsoft Entra sign-in is recorded as attested by the provider only. We store no
// token, claim, IP or user agent, and we never claim MFA or phishing resistance we cannot prove.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withTenantDb } from "../db/scoped-client";

export type SignInIdentity = Readonly<{ organizationId: string; tenantId: string; subjectId: string;
  identityAccountId: string; providerConnectionId: string }>;

export const ENTRA_ASSURANCE_PROFILE = "ENTRA_OIDC_PROVIDER_ATTESTED";
/** F4 (S4): a generic OIDC sign-in, attested by the provider only, exactly like the profile above. */
export const GENERIC_OIDC_ASSURANCE_PROFILE = "OIDC_GENERIC_PROVIDER_ATTESTED";

/** Evidence for a Microsoft Entra OIDC sign-in, success (VERIFIED) or refusal (REJECTED). */
export function entraSignInEvidence(identity: SignInIdentity, outcome: "VERIFIED" | "REJECTED", reasonCode: string,
  now = new Date()): Prisma.AuthenticationEvidenceUncheckedCreateInput {
  return federatedSignInEvidence(ENTRA_ASSURANCE_PROFILE, identity, outcome, reasonCode, now);
}

/** Evidence for a generic OIDC sign-in (F4), success (VERIFIED) or refusal (REJECTED). */
export function genericOidcSignInEvidence(identity: SignInIdentity, outcome: "VERIFIED" | "REJECTED", reasonCode: string,
  now = new Date()): Prisma.AuthenticationEvidenceUncheckedCreateInput {
  return federatedSignInEvidence(GENERIC_OIDC_ASSURANCE_PROFILE, identity, outcome, reasonCode, now);
}

function federatedSignInEvidence(assuranceProfile: string, identity: SignInIdentity, outcome: "VERIFIED" | "REJECTED",
  reasonCode: string, now: Date): Prisma.AuthenticationEvidenceUncheckedCreateInput {
  const operationId = randomUUID();
  return {
    id: randomUUID(), ...identity,
    method: "FEDERATED_OIDC", outcome, source: "EXTERNAL_PROVIDER",
    assuranceLevel: "LOW", assuranceProfile, assuranceProfileVersion: 1,
    userVerification: "PROVIDER_ASSERTED", phishingResistant: false, hardwareBound: false,
    // Reference to our own callback operation, never to provider token material.
    sourceRef: `oidc-callback:${operationId}`, verifierPolicyVersion: 1, operationId,
    reasonCode, occurredAt: now,
  };
}

/** Best-effort write of a REJECTED sign-in for an already-resolved identity. A failure here never
 *  turns a refusal into a success; it is only logged with a safe code. */
export async function recordRejectedSignIn(evidence: Prisma.AuthenticationEvidenceUncheckedCreateInput): Promise<void> {
  if (evidence.outcome !== "REJECTED") throw new Error("REJECTED_EVIDENCE_REQUIRED");
  try {
    await withTenantDb({ organizationId: evidence.organizationId, tenantId: evidence.tenantId },
      tx => tx.authenticationEvidence.create({ data: evidence }));
  } catch {
    console.error("SIGN_IN_REJECTION_EVIDENCE_WRITE_FAILED");
  }
}
