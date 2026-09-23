import { randomUUID } from "node:crypto";

export const SUBJECT_KINDS = [
  "HUMAN", "DEVICE", "WORKLOAD", "SERVICE", "AI_AGENT",
] as const;
export type UniversalSubjectKind = (typeof SUBJECT_KINDS)[number];

export const SUBJECT_LIFECYCLE_STATES = [
  "PROVISIONING", "ACTIVE", "SUSPENDED", "DISABLED", "RECOVERY_REQUIRED", "RETIRED",
] as const;
export type SubjectLifecycleState = (typeof SUBJECT_LIFECYCLE_STATES)[number];

const transitions: Readonly<Record<SubjectLifecycleState, ReadonlySet<SubjectLifecycleState>>> = {
  PROVISIONING: new Set(["ACTIVE", "DISABLED", "RETIRED"]),
  ACTIVE: new Set(["SUSPENDED", "DISABLED", "RECOVERY_REQUIRED", "RETIRED"]),
  SUSPENDED: new Set(["ACTIVE", "DISABLED", "RECOVERY_REQUIRED", "RETIRED"]),
  DISABLED: new Set(["ACTIVE", "RETIRED"]),
  RECOVERY_REQUIRED: new Set(["ACTIVE", "SUSPENDED", "DISABLED", "RETIRED"]),
  RETIRED: new Set(),
};

export function canTransitionSubject(
  from: SubjectLifecycleState,
  to: SubjectLifecycleState,
): boolean {
  return from === to || transitions[from].has(to);
}

export function assertSubjectLifecycleTransition(
  from: SubjectLifecycleState,
  to: SubjectLifecycleState,
): void {
  if (!canTransitionSubject(from, to)) {
    throw new Error(`INVALID_SUBJECT_LIFECYCLE_TRANSITION:${from}:${to}`);
  }
}

export const CREDENTIAL_TYPES = [
  "PASSKEY", "SECURITY_KEY", "TOTP", "SMART_CARD", "MANAGED_DEVICE",
  "FEDERATED", "DEVICE_KEY", "WORKLOAD_KEY", "SERVICE_KEY", "AGENT_KEY", "CUSTOM",
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];
export type CredentialStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED" | "COMPROMISED" | "EXPIRED" | "SUPERSEDED";

export type CredentialDescriptorV1 = Readonly<{
  schemaVersion: 1;
  credentialId: string;
  subjectId: string;
  identityAccountId?: string;
  type: CredentialType;
  format: string;
  formatVersion: number;
  status: CredentialStatus;
  algorithmId?: string;
  keyId?: string;
  keyVersion?: string;
  trustAnchorId?: string;
  trustAnchorVersion?: string;
  verifierPolicyVersion: number;
  hardwareBound: boolean;
  exportability: "NON_EXPORTABLE" | "PUBLIC_ONLY" | "ENCRYPTED_RECOVERY_ONLY";
}>;

export type DeviceBinding = Readonly<{
  deviceSubjectId: string;
  bindingType: "PLATFORM_BOUND" | "HARDWARE_ATTESTED" | "MANAGED_DEVICE";
  bindingVersion: number;
  attestationEvidenceId?: string;
}>;

export type CredentialDescriptorV2 = Readonly<{
  schemaVersion: 2;
  credentialId: string;
  subjectId: string;
  identityAccountId?: string;
  type: CredentialType;
  format: string;
  formatVersion: number;
  status: CredentialStatus;
  crypto: Readonly<{
    algorithmId: string;
    algorithmVersion: number;
    keyId?: string;
    keyVersion?: number;
    trustAnchorId?: string;
    trustAnchorVersion?: number;
    verifierPolicyVersion: number;
  }>;
  deviceBinding?: DeviceBinding;
  exportability: "NON_EXPORTABLE" | "PUBLIC_ONLY" | "ENCRYPTED_RECOVERY_ONLY";
  supersedesCredentialId?: string;
}>;

export type CredentialDescriptor = CredentialDescriptorV1 | CredentialDescriptorV2;

export const AUTHENTICATION_METHODS = [
  "PASSKEY", "SECURITY_KEY", "TOTP", "SMART_CARD", "MANAGED_DEVICE",
  "FEDERATED_OIDC", "DEVICE_KEY", "WORKLOAD_KEY", "SERVICE_KEY", "AGENT_KEY", "CUSTOM",
] as const;
export type AuthenticationMethod = (typeof AUTHENTICATION_METHODS)[number];
export type AuthenticationAssuranceLevel = "LOW" | "SUBSTANTIAL" | "HIGH";
export type AuthenticationUserVerification =
  | "VERIFIED"
  | "PROVIDER_ASSERTED"
  | "NOT_VERIFIED"
  | "NOT_APPLICABLE";

export type AuthenticationAssurance = Readonly<{
  level: AuthenticationAssuranceLevel;
  profile: string;
  profileVersion: number;
  phishingResistant: boolean;
  hardwareBound: boolean;
  userVerification: AuthenticationUserVerification;
}>;

export type EvidenceProvenance = Readonly<{
  schemaVersion: 1;
  source: "LOCAL_VERIFIER" | "EXTERNAL_PROVIDER";
  sourceRef: string;
  verifierPolicyVersion: number;
  operationId: string;
  correlationId?: string;
  causationId?: string;
  occurredAt: string;
  algorithmId?: string;
  algorithmVersion?: number;
  keyId?: string;
  keyVersion?: string;
  trustAnchorId?: string;
  trustAnchorVersion?: number;
  evidenceDigest?: string;
  offline: boolean;
  partitionEpoch?: string;
}>;

export type AuthenticationEvidenceEnvelope = Readonly<{
  evidenceId: string;
  evidenceType: "AUTHENTICATION";
  organizationId: string;
  tenantId: string;
  providerConnectionId: string;
  subjectId?: string;
  identityAccountId?: string;
  externalObjectId: string;
  method: AuthenticationMethod;
  outcome: "VERIFIED";
  reasonCode: string;
  assurance: AuthenticationAssurance;
  provenance: EvidenceProvenance;
  expiresAt?: string;
}>;

export function createAuthenticationEvidence(input: Omit<AuthenticationEvidenceEnvelope, "evidenceId" | "evidenceType" | "outcome">): AuthenticationEvidenceEnvelope {
  for (const value of [input.organizationId, input.tenantId, input.providerConnectionId,
    input.externalObjectId, input.reasonCode, input.assurance.profile,
    input.provenance.sourceRef, input.provenance.operationId, input.provenance.occurredAt]) {
    if (!value.trim()) throw new Error("INVALID_AUTHENTICATION_EVIDENCE");
  }
  if (input.assurance.profileVersion < 1 || input.provenance.schemaVersion !== 1 ||
      input.provenance.verifierPolicyVersion < 1) throw new Error("INVALID_AUTHENTICATION_EVIDENCE_VERSION");
  return Object.freeze({ ...input, evidenceId: randomUUID(), evidenceType: "AUTHENTICATION", outcome: "VERIFIED" });
}
