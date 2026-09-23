export type SecretPurpose = "TOTP_SEED" | "PRIVATE_KEY" | "ENCRYPTION_KEY" | "RECOVERY_KEY";
export type SecretCustodyState = "ACTIVE" | "VERIFY_ONLY" | "REVOKED" | "COMPROMISED" | "RETIRED";

export type VersionedSecretReference = Readonly<{
  custodyProvider: string;
  handle: string;
  version: string;
  purpose: SecretPurpose;
  algorithmId: string;
  algorithmVersion: number;
  state: SecretCustodyState;
}>;

export type SecretCustodyScope = Readonly<{ organizationId: string; tenantId: string }>;

export interface CustodySecretLease {
  use<T>(consumer: (secret: Uint8Array) => Promise<T> | T): Promise<T>;
  toString(): "[REDACTED]";
  toJSON(): "[REDACTED]";
}

/**
 * Custody systems generate and rotate secret bytes internally. LUXIA receives
 * only versioned handles; raw values exist solely inside a short-lived lease.
 */
export interface SecretCustody {
  generate(scope: SecretCustodyScope, request: Readonly<{
    purpose: SecretPurpose; algorithmId: string; algorithmVersion: number;
  }>): Promise<VersionedSecretReference>;
  rotate(scope: SecretCustodyScope, current: VersionedSecretReference): Promise<Readonly<{
    previous: VersionedSecretReference; next: VersionedSecretReference;
  }>>;
  revoke(scope: SecretCustodyScope, reference: VersionedSecretReference, reason: "REVOKED" | "COMPROMISED"): Promise<void>;
  withSecret<T>(scope: SecretCustodyScope, reference: VersionedSecretReference, consumer: (lease: CustodySecretLease) => Promise<T>): Promise<T>;
}
