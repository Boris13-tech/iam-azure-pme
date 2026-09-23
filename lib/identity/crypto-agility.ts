import type { AuthenticationEvidenceEnvelope, CredentialDescriptor, CredentialDescriptorV2 } from "./semantics";

export type CryptoPurpose =
  | "WEBAUTHN_ASSERTION"
  | "TOTP"
  | "EVIDENCE_DIGEST"
  | "EVIDENCE_SIGNATURE"
  | "SECRET_ENCRYPTION"
  | "TRUST_ANCHOR";
export type CryptoAlgorithmStatus = "ACTIVE" | "VERIFY_ONLY" | "DISABLED";

export type CryptoAlgorithmDefinition = Readonly<{
  id: string;
  version: number;
  purposes: ReadonlySet<CryptoPurpose>;
  status: CryptoAlgorithmStatus;
  nodeSignatureDigest?: "sha256";
  hashDigest?: "sha256";
  nodeHmacDigest?: "sha1";
}>;

export class CryptoPolicyError extends Error {
  constructor(readonly code: "UNSUPPORTED_CRYPTO_VERSION" | "CRYPTO_PURPOSE_MISMATCH" | "CRYPTO_DISABLED" | "INVALID_KEY_ROTATION" | "INVALID_CREDENTIAL_UPGRADE") {
    super(code); this.name = "CryptoPolicyError";
  }
}

export class CryptoAlgorithmRegistry {
  private readonly algorithms = new Map<string, CryptoAlgorithmDefinition>();
  constructor(definitions: ReadonlyArray<CryptoAlgorithmDefinition>) {
    for (const definition of definitions) {
      if (definition.version < 1 || this.algorithms.has(key(definition.id, definition.version)))
        throw new CryptoPolicyError("UNSUPPORTED_CRYPTO_VERSION");
      this.algorithms.set(key(definition.id, definition.version), Object.freeze({ ...definition, purposes: new Set(definition.purposes) }));
    }
  }
  resolve(id: string, version: number, purpose: CryptoPurpose, mode: "CREATE" | "VERIFY"): CryptoAlgorithmDefinition {
    const definition = this.algorithms.get(key(id, version));
    if (!definition) throw new CryptoPolicyError("UNSUPPORTED_CRYPTO_VERSION");
    if (!definition.purposes.has(purpose)) throw new CryptoPolicyError("CRYPTO_PURPOSE_MISMATCH");
    if (definition.status === "DISABLED" || (mode === "CREATE" && definition.status !== "ACTIVE"))
      throw new CryptoPolicyError("CRYPTO_DISABLED");
    return definition;
  }
}

export const LUXIA_CRYPTO_ALGORITHMS = new CryptoAlgorithmRegistry([
  { id: "WEBAUTHN_ES256", version: 1, purposes: new Set(["WEBAUTHN_ASSERTION"]), status: "ACTIVE", nodeSignatureDigest: "sha256", hashDigest: "sha256" },
  { id: "TOTP_HMAC_SHA1", version: 1, purposes: new Set(["TOTP"]), status: "ACTIVE", nodeHmacDigest: "sha1" },
  { id: "EVIDENCE_ES256", version: 1, purposes: new Set(["EVIDENCE_SIGNATURE"]), status: "ACTIVE", nodeSignatureDigest: "sha256", hashDigest: "sha256" },
  { id: "SHA256", version: 1, purposes: new Set(["EVIDENCE_DIGEST", "TRUST_ANCHOR"]), status: "ACTIVE", hashDigest: "sha256" },
]);

export const CURRENT_WEBAUTHN_CRYPTO = Object.freeze({ algorithmId: "WEBAUTHN_ES256", algorithmVersion: 1 });
export const CURRENT_TOTP_CRYPTO = Object.freeze({ algorithmId: "TOTP_HMAC_SHA1", algorithmVersion: 1 });
export const CURRENT_EVIDENCE_SIGNATURE_CRYPTO = Object.freeze({ algorithmId: "EVIDENCE_ES256", algorithmVersion: 1 });

export type CryptoKeyLifecycleState = "PENDING" | "ACTIVE" | "VERIFY_ONLY" | "REVOKED" | "COMPROMISED" | "RETIRED";
export type VersionedKeyDescriptor = Readonly<{
  logicalKeyId: string; version: number; purpose: CryptoPurpose;
  algorithmId: string; algorithmVersion: number; status: CryptoKeyLifecycleState;
}>;

export type VersionedTrustAnchorDescriptor = Readonly<{
  trustAnchorId: string; version: number;
  algorithmId: string; algorithmVersion: number; status: CryptoKeyLifecycleState;
}>;

const keyTransitions: Readonly<Record<CryptoKeyLifecycleState, ReadonlySet<CryptoKeyLifecycleState>>> = {
  PENDING: new Set(["ACTIVE", "REVOKED", "COMPROMISED"]),
  ACTIVE: new Set(["VERIFY_ONLY", "REVOKED", "COMPROMISED"]),
  VERIFY_ONLY: new Set(["RETIRED", "REVOKED", "COMPROMISED"]),
  REVOKED: new Set(["RETIRED"]),
  COMPROMISED: new Set(["RETIRED"]),
  RETIRED: new Set(),
};

export function assertKeyLifecycleTransition(from: CryptoKeyLifecycleState, to: CryptoKeyLifecycleState): void {
  if (from !== to && !keyTransitions[from].has(to)) throw new CryptoPolicyError("INVALID_KEY_ROTATION");
}

export function planKeyRotation(current: VersionedKeyDescriptor, replacement: VersionedKeyDescriptor): Readonly<{
  previous: VersionedKeyDescriptor; next: VersionedKeyDescriptor;
}> {
  if (current.logicalKeyId !== replacement.logicalKeyId || current.purpose !== replacement.purpose ||
      current.status !== "ACTIVE" || replacement.status !== "PENDING" || replacement.version <= current.version)
    throw new CryptoPolicyError("INVALID_KEY_ROTATION");
  LUXIA_CRYPTO_ALGORITHMS.resolve(replacement.algorithmId, replacement.algorithmVersion, replacement.purpose, "CREATE");
  return { previous: { ...current, status: "VERIFY_ONLY" }, next: { ...replacement, status: "ACTIVE" } };
}

export function planTrustAnchorRotation(current: VersionedTrustAnchorDescriptor, replacement: VersionedTrustAnchorDescriptor): Readonly<{
  previous: VersionedTrustAnchorDescriptor; next: VersionedTrustAnchorDescriptor;
}> {
  if (current.trustAnchorId !== replacement.trustAnchorId || current.status !== "ACTIVE" || replacement.status !== "PENDING" ||
      replacement.version <= current.version)
    throw new CryptoPolicyError("INVALID_KEY_ROTATION");
  LUXIA_CRYPTO_ALGORITHMS.resolve(replacement.algorithmId, replacement.algorithmVersion, "TRUST_ANCHOR", "CREATE");
  return { previous: { ...current, status: "VERIFY_ONLY" }, next: { ...replacement, status: "ACTIVE" } };
}

export function assertCredentialLifecycleTransition(from: CredentialDescriptor["status"], to: CredentialDescriptor["status"]): void {
  const allowed: Readonly<Record<CredentialDescriptor["status"], ReadonlySet<CredentialDescriptor["status"]>>> = {
    PENDING: new Set(["ACTIVE", "REVOKED", "COMPROMISED", "EXPIRED"]),
    ACTIVE: new Set(["SUSPENDED", "REVOKED", "COMPROMISED", "EXPIRED", "SUPERSEDED"]),
    SUSPENDED: new Set(["ACTIVE", "REVOKED", "COMPROMISED", "EXPIRED", "SUPERSEDED"]),
    REVOKED: new Set(), COMPROMISED: new Set(), EXPIRED: new Set(), SUPERSEDED: new Set(),
  };
  if (from !== to && !allowed[from].has(to)) throw new CryptoPolicyError("INVALID_CREDENTIAL_UPGRADE");
}

export function planCredentialUpgrade(current: CredentialDescriptor, replacement: CredentialDescriptorV2): Readonly<{
  previousCredentialId: string; nextCredentialId: string; previousStatus: "SUPERSEDED"; nextStatus: "ACTIVE";
}> {
  if (current.subjectId !== replacement.subjectId || current.identityAccountId !== replacement.identityAccountId ||
      current.status !== "ACTIVE" || replacement.status !== "PENDING" || replacement.credentialId === current.credentialId ||
      replacement.crypto.verifierPolicyVersion < 1 || replacement.formatVersion < current.formatVersion)
    throw new CryptoPolicyError("INVALID_CREDENTIAL_UPGRADE");
  const purpose: CryptoPurpose = replacement.type === "TOTP" ? "TOTP" : "WEBAUTHN_ASSERTION";
  LUXIA_CRYPTO_ALGORITHMS.resolve(replacement.crypto.algorithmId, replacement.crypto.algorithmVersion, purpose, "CREATE");
  return { previousCredentialId: current.credentialId, nextCredentialId: replacement.credentialId, previousStatus: "SUPERSEDED", nextStatus: "ACTIVE" };
}

export type HistoricalEvidenceCompatibility =
  | "LEGACY_COMPATIBLE"
  | "CURRENT_KEY"
  | "ROTATED_KEY_VERIFY_ONLY"
  | "RETIRED_KEY_HISTORICAL"
  | "KEY_REVOKED"
  | "KEY_COMPROMISED";

export function assessHistoricalEvidenceCompatibility(
  evidence: AuthenticationEvidenceEnvelope,
  keyDescriptor?: VersionedKeyDescriptor,
): HistoricalEvidenceCompatibility {
  const provenance = evidence.provenance;
  if (!provenance.algorithmId && !provenance.keyId && !provenance.keyVersion) return "LEGACY_COMPATIBLE";
  if (!provenance.algorithmId || !provenance.algorithmVersion || !provenance.keyId || !provenance.keyVersion || !keyDescriptor)
    throw new CryptoPolicyError("UNSUPPORTED_CRYPTO_VERSION");
  LUXIA_CRYPTO_ALGORITHMS.resolve(provenance.algorithmId, provenance.algorithmVersion, keyDescriptor.purpose, "VERIFY");
  if (keyDescriptor.logicalKeyId !== provenance.keyId || String(keyDescriptor.version) !== provenance.keyVersion ||
      keyDescriptor.algorithmId !== provenance.algorithmId || keyDescriptor.algorithmVersion !== provenance.algorithmVersion)
    throw new CryptoPolicyError("UNSUPPORTED_CRYPTO_VERSION");
  switch (keyDescriptor.status) {
    case "ACTIVE": return "CURRENT_KEY";
    case "VERIFY_ONLY": return "ROTATED_KEY_VERIFY_ONLY";
    case "RETIRED": return "RETIRED_KEY_HISTORICAL";
    case "REVOKED": return "KEY_REVOKED";
    case "COMPROMISED": return "KEY_COMPROMISED";
    case "PENDING": throw new CryptoPolicyError("CRYPTO_DISABLED");
  }
}

function key(id: string, version: number): string { return `${id}\u0000${version}`; }
