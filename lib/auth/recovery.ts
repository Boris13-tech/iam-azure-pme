import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AuthContext } from "./auth-context";
import type { RecoveryContext } from "./recovery-session";
import { normalizeOrganizationSlug, normalizePrincipalName, resolveLoginOrganization } from "./organization-login";
import { recordRejectedSignIn } from "./sign-in-evidence";
import { RECOVERY_ASSURANCE_PROFILE } from "./recovery-evidence";
import { CanonicalAdminError } from "../admin/canonical-admin-error";
import { withTenantDb } from "../db/scoped-client";
import { CURRENT_WEBAUTHN_CRYPTO } from "../identity";
import { lockOrganizationActive } from "../organizations/lifecycle";
import { registrationChallenge, verifyPasskeyRegistration, type PasskeyRegistration } from "../provider-adapters/implementations/luxia-local/webauthn-registration";

// First Admin / Break-glass v1, B2: personal recovery codes and the recovery-only session.
// Design (R1 to R6 approved 2026-10-11): docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-B2-RECOVERY-DESIGN.md
// Self-service only: a person acts on their own LUXIA local account, never on someone else's, and
// nothing here grants or checks a permission (operator procedures are B4, elsewhere).
// Lock order, as in B1 and B3: the organization row (FOR SHARE) first, then the person's own rows.

type Tx = Prisma.TransactionClient;
type Scope = { organizationId: string; tenantId: string };

export const RECOVERY_CODES_PER_BATCH = 10;
export const RECOVERY_SESSION_MS = 15 * 60_000;        // section 5, enforced by the Session CHECK
export const RECENT_PASSKEY_SIGN_IN_MS = 15 * 60_000;  // decision R2
const ENROLLMENT_CHALLENGE_MS = 5 * 60_000;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";   // Crockford base32
const CODE = /^[0-9A-HJKMNP-TV-Z]{20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------
// Codes: 20 Crockford base32 characters (100 bits), shown once, stored only as a hash.
// ---------------------------------------------------------------------------------------------

export function newRecoveryCode(): string {
  // 256 is a multiple of 32, so the low 5 bits of each random byte are uniform.
  return Array.from(randomBytes(20), (byte) => ALPHABET[byte & 31]).join("");
}

/** XXXXX-XXXXX-XXXXX-XXXXX */
export const formatRecoveryCode = (code: string) => code.match(/.{5}/g)!.join("-");

/** Upper case, no spaces or hyphens, O read as 0, I and L read as 1. Null unless it is a code. */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return CODE.test(code) ? code : null;
}

/** Domain-separated and bound to the identity account: a code can never match another account. */
export function recoveryCodeHash(identityAccountId: string, code: string): string {
  return createHash("sha256").update(`luxia-recovery-code:v1:${identityAccountId}:${code}`, "utf8").digest("hex");
}

const challengeHash = (challenge: string) => createHash("sha256").update(challenge).digest("base64url");

/** Same rule as the passkey verifier: refused while DISABLED or while a lock has not expired. */
function usableLocalIdentity(local: { status: string; lockedUntil: Date | null }, now: Date): boolean {
  if (local.status === "ACTIVE") return true;
  return local.status === "LOCKED" && local.lockedUntil !== null && local.lockedUntil <= now;
}

// ---------------------------------------------------------------------------------------------
// Signed-in person (FULL session): status, generation, revocation.
// ---------------------------------------------------------------------------------------------

const scopeOf = (auth: AuthContext): Scope => ({ organizationId: auth.organizationId, tenantId: auth.tenantId });

/** The person's own LUXIA local identity for the session's account, row-locked; null otherwise. */
async function lockOwnLocalIdentity(tx: Tx, auth: AuthContext, now: Date): Promise<{ id: string } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string; lockedUntil: Date | null }>>`
    SELECT li."id", li."status"::text AS status, li."lockedUntil"
    FROM "LocalIdentity" li
    JOIN "IdentityAccount" ia ON ia."organizationId" = li."organizationId" AND ia."tenantId" = li."tenantId" AND ia."id" = li."identityAccountId"
    JOIN "ProviderConnection" pc ON pc."organizationId" = ia."organizationId" AND pc."id" = ia."providerConnectionId"
    WHERE li."organizationId" = ${auth.organizationId} AND li."tenantId" = ${auth.tenantId} AND li."identityAccountId" = ${auth.identityAccountId}
      AND ia."subjectId" = ${auth.subjectId} AND ia."status" = 'ACTIVE' AND pc."providerType" = 'LUXIA_LOCAL'
    FOR NO KEY UPDATE OF li`;
  return rows[0] && usableLocalIdentity(rows[0], now) ? { id: rows[0].id } : null;
}

/**
 * R2: this session was opened by a passkey sign-in less than 15 minutes ago. A FULL session on a
 * local account comes only from a passkey sign-in, whose VERIFIED evidence is written in the session
 * transaction (W1): both are required, and the evidence must belong to this session's creation.
 */
async function requireRecentPasskeySignIn(tx: Tx, auth: AuthContext, now: Date): Promise<void> {
  const since = new Date(now.getTime() - RECENT_PASSKEY_SIGN_IN_MS);
  const session = await tx.session.findFirst({ where: { ...scopeOf(auth), id: auth.sessionId, subjectId: auth.subjectId,
    identityAccountId: auth.identityAccountId, scope: "FULL", revokedAt: null, expiresAt: { gt: now }, createdAt: { gte: since } },
    select: { createdAt: true } });
  const evidence = session && await tx.authenticationEvidence.findFirst({ where: { ...scopeOf(auth), subjectId: auth.subjectId,
    identityAccountId: auth.identityAccountId, outcome: "VERIFIED", method: { in: ["PASSKEY", "SECURITY_KEY"] },
    occurredAt: { gte: new Date(Math.max(since.getTime(), session.createdAt.getTime() - 120_000)), lte: new Date(session.createdAt.getTime() + 5_000) } },
    select: { id: true } });
  if (!evidence) throw new CanonicalAdminError("RECENT_PASSKEY_SIGN_IN_REQUIRED", 403);
}

export type RecoveryCodeStatus = Readonly<{
  available: boolean;                  // a LUXIA local account (Microsoft-only accounts get no codes)
  remaining: number;
  batchCreatedAt: string | null;
  recoveryUsedInCurrentBatch: boolean; // R5: drives the notice until a new batch exists
}>;

export async function recoveryCodeStatus(auth: AuthContext, now = new Date()): Promise<RecoveryCodeStatus> {
  return withTenantDb(scopeOf(auth), async (tx) => {
    const own = { ...scopeOf(auth), identityAccountId: auth.identityAccountId };
    const local = await tx.localIdentity.findFirst({ where: { ...own, identityAccount: { subjectId: auth.subjectId, status: "ACTIVE",
      providerConnection: { providerType: "LUXIA_LOCAL" } } }, select: { status: true, lockedUntil: true } });
    if (!local || !usableLocalIdentity(local, now)) return { available: false, remaining: 0, batchCreatedAt: null, recoveryUsedInCurrentBatch: false };
    const latest = await tx.localRecoveryCode.findFirst({ where: own, orderBy: { createdAt: "desc" }, select: { batchId: true, createdAt: true } });
    if (!latest) return { available: true, remaining: 0, batchCreatedAt: null, recoveryUsedInCurrentBatch: false };
    const remaining = await tx.localRecoveryCode.count({ where: { ...own, usedAt: null, revokedAt: null } });
    const used = await tx.localRecoveryCode.count({ where: { ...own, batchId: latest.batchId, usedAt: { not: null } } });
    return { available: true, remaining, batchCreatedAt: latest.createdAt.toISOString(), recoveryUsedInCurrentBatch: used > 0 };
  });
}

/**
 * A new batch of 10 codes, returned once. In one transaction: the unused codes of earlier batches
 * are revoked, the new hashes are stored and the journal event is written.
 */
export async function generateRecoveryCodes(auth: AuthContext, changeId: string, now = new Date()) {
  const scope = scopeOf(auth);
  return withTenantDb(scope, async (tx) => {
    if (!await lockOrganizationActive(tx, auth.organizationId)) throw new CanonicalAdminError("FORBIDDEN", 403);
    if (await tx.canonicalAdminAuditEvent.findFirst({ where: { ...scope, changeId }, select: { id: true } }))
      throw new CanonicalAdminError("CHANGE_ALREADY_APPLIED", 409);
    // Serializes generations, revocations and code consumption checks of this account.
    if (!await lockOwnLocalIdentity(tx, auth, now)) throw new CanonicalAdminError("RECOVERY_CODES_NOT_AVAILABLE", 403);
    await requireRecentPasskeySignIn(tx, auth, now);
    const own = { ...scope, identityAccountId: auth.identityAccountId };
    const revoked = await tx.localRecoveryCode.updateMany({ where: { ...own, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    const batchId = randomUUID();
    const codes = Array.from({ length: RECOVERY_CODES_PER_BATCH }, newRecoveryCode);
    await tx.localRecoveryCode.createMany({ data: codes.map((code) => ({
      ...own, codeHash: recoveryCodeHash(auth.identityAccountId, code), batchId, createdAt: now,
    })) });
    await tx.canonicalAdminAuditEvent.create({ data: { ...scope, actorSubjectId: auth.subjectId, targetSubjectId: auth.subjectId,
      operation: "RECOVERY_CODES.GENERATE", result: "SUCCESS", changeId,
      metadata: { batchId, count: RECOVERY_CODES_PER_BATCH, revokedCodes: revoked.count } } });
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return { batchId, createdAt: now.toISOString(), codes: codes.map(formatRecoveryCode), revokedCodes: revoked.count };
  });
}

/** "Revoke all my codes": every unused code of the account, once, with its journal event. */
export async function revokeRecoveryCodes(auth: AuthContext, changeId: string, now = new Date()) {
  const scope = scopeOf(auth);
  return withTenantDb(scope, async (tx) => {
    if (!await lockOrganizationActive(tx, auth.organizationId)) throw new CanonicalAdminError("FORBIDDEN", 403);
    if (await tx.canonicalAdminAuditEvent.findFirst({ where: { ...scope, changeId }, select: { id: true } }))
      throw new CanonicalAdminError("CHANGE_ALREADY_APPLIED", 409);
    if (!await lockOwnLocalIdentity(tx, auth, now)) throw new CanonicalAdminError("RECOVERY_CODES_NOT_AVAILABLE", 403);
    const revoked = await tx.localRecoveryCode.updateMany({ where: { ...scope, identityAccountId: auth.identityAccountId, usedAt: null, revokedAt: null },
      data: { revokedAt: now } });
    await tx.canonicalAdminAuditEvent.create({ data: { ...scope, actorSubjectId: auth.subjectId, targetSubjectId: auth.subjectId,
      operation: "RECOVERY_CODES.REVOKE", result: "SUCCESS", changeId, metadata: { revokedCodes: revoked.count } } });
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return { revokedCodes: revoked.count };
  });
}

// ---------------------------------------------------------------------------------------------
// Recovery sign-in (before authentication). Every refusal is the same null: the route answers with
// the generic LOCAL_AUTHENTICATION_FAILED. The precise reason is kept only in REJECTED evidence of
// a known person.
// ---------------------------------------------------------------------------------------------

type Person = { subjectId: string; identityAccountId: string };

function recoveryEvidence(scope: Scope, person: Person, providerConnectionId: string, outcome: "VERIFIED" | "REJECTED",
  reasonCode: string, now: Date): Prisma.AuthenticationEvidenceUncheckedCreateInput {
  const operationId = randomUUID();
  return {
    id: randomUUID(), ...scope, ...person, providerConnectionId,
    method: "CUSTOM", outcome, source: "LOCAL_VERIFIER",
    assuranceLevel: "LOW", assuranceProfile: RECOVERY_ASSURANCE_PROFILE, assuranceProfileVersion: 1,
    phishingResistant: false, hardwareBound: false, userVerification: "NOT_VERIFIED",
    sourceRef: `recovery-sign-in:${operationId}`, verifierPolicyVersion: 1, operationId, reasonCode, occurredAt: now,
  };
}

export type RecoverySignIn = Readonly<{ rawToken: string; expiresAt: Date }>;

export async function recoverySignIn(input: { organization: unknown; principalName: unknown; code: unknown }, now = new Date()): Promise<RecoverySignIn | null> {
  const slug = normalizeOrganizationSlug(input.organization);
  const principalName = normalizePrincipalName(input.principalName);
  const code = normalizeRecoveryCode(input.code);
  if (!slug || !principalName || !code) return null;
  const organization = await resolveLoginOrganization(slug); // null unless ACTIVE (B3)
  if (!organization?.localConnectionId) return null;
  const { organizationId, tenantId, localConnectionId } = organization;
  const scope = { organizationId, tenantId };
  const rawToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + RECOVERY_SESSION_MS);

  const outcome = await withTenantDb(scope, async (tx): Promise<{ person?: Person; refused?: string }> => {
    const active = await lockOrganizationActive(tx, organizationId);
    const local = await tx.localIdentity.findFirst({ where: { ...scope, principalName, identityAccount: { providerConnectionId: localConnectionId } },
      select: { status: true, lockedUntil: true, identityAccount: { select: { id: true, subjectId: true, status: true, subject: { select: { lifecycleState: true } } } } } });
    if (!local) return { refused: "UNKNOWN_IDENTITY" };
    const person = { subjectId: local.identityAccount.subjectId, identityAccountId: local.identityAccount.id };
    if (!active) return { person, refused: "ORGANIZATION_NOT_ACTIVE" };
    if (!usableLocalIdentity(local, now)) return { person, refused: "LOCAL_IDENTITY_NOT_ACTIVE" };
    if (local.identityAccount.status !== "ACTIVE") return { person, refused: "IDENTITY_ACCOUNT_DISABLED" };
    if (local.identityAccount.subject.lifecycleState !== "ACTIVE") return { person, refused: "SUBJECT_NOT_ACTIVE" };
    // Single use: conditional, and the database guard refuses any second write to the row.
    const consumed = await tx.localRecoveryCode.updateMany({ where: { ...scope, identityAccountId: person.identityAccountId,
      codeHash: recoveryCodeHash(person.identityAccountId, code), usedAt: null, revokedAt: null }, data: { usedAt: now } });
    if (consumed.count !== 1) return { person, refused: "RECOVERY_CODE_INVALID" };
    await tx.authenticationEvidence.create({ data: recoveryEvidence(scope, person, localConnectionId, "VERIFIED", "LOCAL_RECOVERY_CODE_VERIFIED", now) });
    // createdAt and expiresAt from the same clock: the database CHECK allows 15 minutes at most.
    await tx.session.create({ data: { id: createHash("sha256").update(rawToken).digest("hex"), ...scope, ...person,
      scope: "RECOVERY", createdAt: now, expiresAt, lastSeenAt: now } });
    await tx.canonicalAdminAuditEvent.create({ data: { ...scope, actorSubjectId: person.subjectId, targetSubjectId: person.subjectId,
      operation: "RECOVERY.SIGN_IN", result: "SUCCESS", changeId: `recovery-sign-in:${randomUUID()}`,
      metadata: { method: "RECOVERY_CODE", assuranceLevel: "LOW", expiresAt: expiresAt.toISOString() } } });
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return { person };
  });

  if (!outcome.refused) return { rawToken, expiresAt };
  // W3 pattern: a refusal of a known person is recorded (separate transaction, best effort).
  if (outcome.person) await recordRejectedSignIn(recoveryEvidence(scope, outcome.person, localConnectionId, "REJECTED", outcome.refused, now));
  return null;
}

// ---------------------------------------------------------------------------------------------
// Recovery session: enrol a new passkey for the session's own account, which ends the session.
// ---------------------------------------------------------------------------------------------

export class RecoveryError extends Error {
  constructor(readonly code: "RECOVERY_SESSION_INVALID" | "PASSKEY_REGISTRATION_INVALID", readonly status: number) {
    super(code);
    this.name = "RecoveryError";
  }
}
const sessionInvalid = () => new RecoveryError("RECOVERY_SESSION_INVALID", 401);
const registrationInvalid = () => new RecoveryError("PASSKEY_REGISTRATION_INVALID", 400);

export async function beginRecoveryEnrollment(context: RecoveryContext, rpId: string, now = new Date()) {
  const r = context.recovery;
  const scope = { organizationId: r.organizationId, tenantId: r.tenantId };
  const challenge = randomBytes(32).toString("base64url");
  return withTenantDb(scope, async (tx) => {
    if (!await lockOrganizationActive(tx, r.organizationId)) throw sessionInvalid();
    const session = await tx.session.findFirst({ where: { ...scope, id: r.sessionId, subjectId: r.subjectId, identityAccountId: r.identityAccountId,
      scope: "RECOVERY", revokedAt: null, expiresAt: { gt: now } }, select: { expiresAt: true } });
    const local = session && await tx.localIdentity.findFirst({ where: { ...scope, identityAccountId: r.identityAccountId,
      identityAccount: { subjectId: r.subjectId, status: "ACTIVE", subject: { lifecycleState: "ACTIVE" } } },
      select: { principalName: true, status: true, lockedUntil: true, identityAccount: { select: { subject: { select: { name: true } } } } } });
    if (!session || !local || !usableLocalIdentity(local, now)) throw sessionInvalid();
    // Purpose RECOVERY: neither the passkey sign-in nor the regular enrolment accepts this challenge.
    const transactionId = randomUUID();
    const expiresAt = new Date(Math.min(now.getTime() + ENROLLMENT_CHALLENGE_MS, session.expiresAt.getTime()));
    await tx.localAuthChallenge.create({ data: { id: transactionId, ...scope, identityAccountId: r.identityAccountId, purpose: "RECOVERY",
      challengeHash: challengeHash(challenge), expiresAt, attempts: 0, maxAttempts: 1, createdAt: now } });
    return {
      transactionId, challenge, expiresAt: expiresAt.toISOString(), rp: { id: rpId, name: "LUXIA Identity" },
      user: { id: randomBytes(16).toString("base64url"), name: local.principalName, displayName: local.identityAccount.subject.name },
    };
  });
}

/**
 * One transaction (section 6, R4): the recovery session ends (once: a second completion is refused),
 * the challenge is consumed, the previous passkeys of the account are revoked, the new passkey is
 * created and every other session of the account ends.
 */
export async function completeRecoveryEnrollment(context: RecoveryContext, input: { transactionId: unknown } & PasskeyRegistration,
  origin: { rpId: string; origin: string }, now = new Date()) {
  const r = context.recovery;
  const scope = { organizationId: r.organizationId, tenantId: r.tenantId };
  const own = { ...scope, identityAccountId: r.identityAccountId };
  const transactionId = typeof input.transactionId === "string" && UUID.test(input.transactionId) ? input.transactionId : null;
  const challenge = typeof input.clientDataJSON === "string" ? registrationChallenge(input.clientDataJSON) : null;
  if (!transactionId || !challenge) throw registrationInvalid();
  let passkey: { credentialId: string; publicKeyPem: string };
  try { passkey = verifyPasskeyRegistration({ ...input, expectedChallenge: challenge, expectedOrigin: origin.origin, rpId: origin.rpId }); }
  catch { throw registrationInvalid(); }
  try {
    return await withTenantDb(scope, async (tx) => {
      if (!await lockOrganizationActive(tx, r.organizationId)) throw sessionInvalid();
      const ended = await tx.session.updateMany({ where: { ...own, id: r.sessionId, subjectId: r.subjectId, scope: "RECOVERY",
        revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now } });
      if (ended.count !== 1) throw sessionInvalid();
      const consumed = await tx.localAuthChallenge.updateMany({ where: { ...own, id: transactionId, purpose: "RECOVERY",
        challengeHash: challengeHash(challenge), usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (consumed.count !== 1) throw registrationInvalid();
      const local = await tx.localIdentity.findFirst({ where: { ...own, identityAccount: { subjectId: r.subjectId, status: "ACTIVE",
        subject: { lifecycleState: "ACTIVE" } } }, select: { id: true, status: true, lockedUntil: true } });
      if (!local || !usableLocalIdentity(local, now)) throw sessionInvalid();
      if (local.status !== "ACTIVE") await tx.localIdentity.update({ where: { id: local.id }, data: { status: "ACTIVE", failedAttempts: 0, lockedUntil: null } });
      // R4: every sign-in authenticator of the account (passkeys and security keys). TOTP is not touched:
      // it is not used as a sign-in authenticator in the product (no route enrols or verifies one).
      const passkeysRevoked = await tx.localAuthenticator.updateMany({ where: { ...own, status: "ACTIVE", type: { in: ["PASSKEY", "SECURITY_KEY"] } },
        data: { status: "REVOKED", revokedAt: now, stateVersion: { increment: 1 } } });
      const authenticatorId = randomUUID();
      await tx.localAuthenticator.create({ data: {
        id: authenticatorId, ...own, type: "PASSKEY", status: "ACTIVE",
        credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY", credentialFormatVersion: 1,
        ...CURRENT_WEBAUTHN_CRYPTO, keyId: authenticatorId, keyVersion: 1, verifierPolicyVersion: 1,
        // Attestation "none": the hardware cannot be proven, so it is not claimed.
        hardwareBound: false, userVerificationRequired: true,
        credentialId: passkey.credentialId, publicKey: passkey.publicKeyPem,
        relyingPartyId: origin.rpId, allowedOrigin: origin.origin, signCount: 0, enrolledAt: now,
      } });
      const sessionsRevoked = await tx.session.updateMany({ where: { ...own, revokedAt: null }, data: { revokedAt: now } });
      const audit = { ...scope, actorSubjectId: r.subjectId, targetSubjectId: r.subjectId, result: "SUCCESS" as const };
      await tx.canonicalAdminAuditEvent.create({ data: { ...audit, operation: "LOCAL_AUTHENTICATOR.ENROLL", changeId: `enroll:${authenticatorId}`,
        metadata: { type: "PASSKEY", via: "RECOVERY" } } });
      await tx.canonicalAdminAuditEvent.create({ data: { ...audit, operation: "RECOVERY.PASSKEY_ENROLLED", changeId: `recovery-enroll:${authenticatorId}`,
        metadata: { passkeysRevoked: passkeysRevoked.count, sessionsRevoked: sessionsRevoked.count } } });
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      return { status: "ENROLLED" as const, passkeysRevoked: passkeysRevoked.count, sessionsRevoked: sessionsRevoked.count };
    });
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    // The same credential already registered (unique per tenant): same refusal as an invalid registration.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw registrationInvalid();
    throw error;
  }
}
