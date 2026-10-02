import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CURRENT_BACKUP_ENCRYPTION_CRYPTO, LUXIA_CRYPTO_ALGORITHMS } from "./crypto-agility";
import { canonicalBytes } from "./continuity";
import type { ContinuityScope } from "./continuity-store";
import { PortabilitySecurityError, verifySovereignExport, type SovereignIdentityPackageV1 } from "./portability";
import type { ContinuitySignatureProvider } from "./continuity";

export interface BackupKeyCustody {
  withKey<T>(scope: ContinuityScope, keyRef: string, operation: (key: Uint8Array) => T): Promise<T>;
}
export type EncryptedSovereignBackupV1 = Readonly<{
  header: Readonly<{ format: "LUXIA_ENCRYPTED_SOVEREIGN_BACKUP"; formatVersion: 1; packageId: string;
    organizationId: string; tenantId: string; recoveryEpoch: number; algorithmId: "AES_256_GCM"; algorithmVersion: 1;
    keyRef: string; createdAt: string }>;
  iv: string; ciphertext: string; authTag: string;
}>;

export async function encryptSovereignBackup(pkg: SovereignIdentityPackageV1, keyRef: string,
  custody: BackupKeyCustody): Promise<EncryptedSovereignBackupV1> {
  LUXIA_CRYPTO_ALGORITHMS.resolve(CURRENT_BACKUP_ENCRYPTION_CRYPTO.algorithmId, 1, "BACKUP_ENCRYPTION", "CREATE");
  if (!keyRef.trim()) throw new PortabilitySecurityError("INVALID_FORMAT");
  const header = Object.freeze({ format: "LUXIA_ENCRYPTED_SOVEREIGN_BACKUP" as const, formatVersion: 1 as const,
    packageId: pkg.manifest.packageId, organizationId: pkg.manifest.organizationId, tenantId: pkg.manifest.tenantId,
    recoveryEpoch: pkg.manifest.recoveryEpoch, algorithmId: "AES_256_GCM" as const, algorithmVersion: 1 as const,
    keyRef, createdAt: pkg.manifest.createdAt });
  const scope = { organizationId: header.organizationId, tenantId: header.tenantId };
  return custody.withKey(scope, keyRef, (key) => {
    if (key.byteLength !== 32) throw new PortabilitySecurityError("INVALID_FORMAT");
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(canonicalBytes(header));
    const ciphertext = Buffer.concat([cipher.update(canonicalBytes(pkg)), cipher.final()]);
    return Object.freeze({ header, iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url") });
  });
}

export async function restoreSovereignBackup(envelope: EncryptedSovereignBackupV1,
  expected: Readonly<{ scope: ContinuityScope; recoveryEpoch: number; seenPackageIds?: ReadonlySet<string> }>,
  custody: BackupKeyCustody, verifier: ContinuitySignatureProvider): Promise<SovereignIdentityPackageV1> {
  const h = envelope.header;
  if (h.format !== "LUXIA_ENCRYPTED_SOVEREIGN_BACKUP" || h.formatVersion !== 1 || h.algorithmId !== "AES_256_GCM" || h.algorithmVersion !== 1)
    throw new PortabilitySecurityError("INVALID_FORMAT");
  if (h.organizationId !== expected.scope.organizationId || h.tenantId !== expected.scope.tenantId) throw new PortabilitySecurityError("INVALID_SCOPE");
  if (h.recoveryEpoch !== expected.recoveryEpoch) throw new PortabilitySecurityError("STALE_RECOVERY_EPOCH");
  let pkg: SovereignIdentityPackageV1;
  try {
    pkg = await custody.withKey(expected.scope, h.keyRef, (key) => {
      if (key.byteLength !== 32) throw new PortabilitySecurityError("INVALID_FORMAT");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
      decipher.setAAD(canonicalBytes(h)); decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
      const clear = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
      return JSON.parse(clear.toString("utf8")) as SovereignIdentityPackageV1;
    });
  } catch (error) {
    if (error instanceof PortabilitySecurityError) throw error;
    throw new PortabilitySecurityError("INTEGRITY_FAILURE");
  }
  if (pkg.manifest.packageId !== h.packageId) throw new PortabilitySecurityError("INTEGRITY_FAILURE");
  return verifySovereignExport(pkg, expected, verifier);
}
