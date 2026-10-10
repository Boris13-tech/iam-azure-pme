import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { rawPrisma } from "../db/raw-prisma";
import { CanonicalAdminError } from "../admin/canonical-administration";
import { operation, requireNative } from "../resources/service";
import { allowRequest } from "../security/rate-limit";
import { normalizePrincipalName } from "../auth/organization-login";
import { assertSubjectLifecycleTransition } from "../identity/semantics";
import { registrationChallenge, verifyPasskeyRegistration, type PasskeyRegistration } from "../provider-adapters/implementations/luxia-local/webauthn-registration";
import { createPasskeyIdentity, grantAdministrator, localConnection } from "./provisioning";
import type { AuthContext } from "../auth/authorization-engine";

// Customer Self-Onboarding v1, step 6 (requirements 8, 9, 16). An administrator invites a person:
// LUXIA creates the identity (PROVISIONING) and a single-use link the administrator copies. No email
// is sent and nothing pretends it was. The token is shown once and only its SHA-256 is stored; the
// database sets the 7-day expiry. Accepting uses the invitation's own tenant, person and role.

export type InvitationRole = "MEMBER" | "ADMIN";
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const context = (auth: AuthContext) => ({ organizationId: auth.organizationId, tenantId: auth.tenantId });

export class InvitationError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "INVITATION_INVALID" | "IDENTIFIER_UNAVAILABLE" | "PASSKEY_REGISTRATION_INVALID", readonly status: number) { super(code); }
}

type Row = { id: string; role: string; createdAt: Date; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null; subject: { id: string; name: string } };
function view(row: Row, now = new Date()) {
  const status = row.acceptedAt ? "ACCEPTED" : row.revokedAt ? "REVOKED" : row.expiresAt <= now ? "EXPIRED" : "PENDING";
  return { id: row.id, name: row.subject.name, subjectId: row.subject.id, role: row.role, status, createdAt: row.createdAt, expiresAt: row.expiresAt, acceptedAt: row.acceptedAt, revokedAt: row.revokedAt };
}

export function listInvitations(auth: AuthContext, changeId: string) {
  return operation(auth, changeId, "INVITATION.READ", "subjects.read", async (tx) => ({
    value: (await tx.invitation.findMany({ where: context(auth), orderBy: { createdAt: "desc" }, take: 200,
      select: { id: true, role: true, createdAt: true, expiresAt: true, acceptedAt: true, revokedAt: true, subject: { select: { id: true, name: true } } } })).map((row) => view(row)),
  }));
}

/** Returns the invitation and its token, once. The caller builds the link to copy. */
export async function createInvitation(auth: AuthContext, changeId: string, input: { name: unknown; role: unknown }) {
  if (!await allowRequest("invitation-create", `subject:${auth.subjectId}`)) throw new CanonicalAdminError("RATE_LIMITED", 429);
  return operation(auth, changeId, "INVITATION.CREATE", "subjects.create", async (tx) => {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const role = input.role === "ADMIN" || input.role === "MEMBER" ? input.role : null;
    if (name.length < 2 || name.length > 120 || !role) throw new CanonicalAdminError("INVALID_REQUEST_BODY", 400);
    // Inviting an administrator is granting access: it needs assignments.manage.
    if (role === "ADMIN") await requireNative(tx, auth, "assignments.manage");
    const subject = await tx.subject.create({ data: { ...context(auth), type: "HUMAN", name, lifecycleState: "PROVISIONING" } });
    const token = randomBytes(32).toString("base64url");
    const invitation = await tx.invitation.create({
      data: { ...context(auth), subjectId: subject.id, tokenHash: sha256Hex(token), role, invitedBySubjectId: auth.subjectId },
      select: { id: true, role: true, createdAt: true, expiresAt: true, acceptedAt: true, revokedAt: true, subject: { select: { id: true, name: true } } },
    });
    return { value: { invitation: view(invitation), token }, targetSubjectId: subject.id, metadata: { invitationId: invitation.id, role } };
  });
}

export function revokeInvitation(auth: AuthContext, changeId: string, id: string) {
  return operation(auth, changeId, "INVITATION.REVOKE", "subjects.create", async (tx) => {
    const row = await tx.invitation.findFirst({ where: { ...context(auth), id } });
    if (!row) throw new CanonicalAdminError("INVITATION_NOT_FOUND", 404);
    if (row.role === "ADMIN") await requireNative(tx, auth, "assignments.manage");
    const updated = await tx.invitation.updateMany({ where: { ...context(auth), id, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date(), pendingChallengeHash: null, pendingExpiresAt: null } });
    if (updated.count !== 1) throw new CanonicalAdminError("INVITATION_NOT_OPEN", 409);
    return { value: { id, status: "REVOKED" }, targetSubjectId: row.subjectId, metadata: { invitationId: id, role: row.role } };
  });
}

type Resolved = { invitation_id: string; organization_id: string; tenant_id: string; subject_id: string; invitation_role: InvitationRole };
async function resolve(token: unknown): Promise<Resolved & { tokenHash: string }> {
  if (typeof token !== "string" || !TOKEN.test(token)) throw new InvitationError("INVITATION_INVALID", 403);
  const tokenHash = sha256Hex(token);
  const rows = await rawPrisma.$queryRaw<Resolved[]>`SELECT * FROM luxia_invitation_resolve(${tokenHash})`;
  if (rows.length !== 1) throw new InvitationError("INVITATION_INVALID", 403);
  return { ...rows[0], tokenHash };
}
async function inTenant<T>(scope: { organizationId: string; tenantId: string }, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return rawPrisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.organization_id', ${scope.organizationId}, true)`;
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${scope.tenantId}, true)`;
    return work(tx);
  }, { maxWait: 10_000, timeout: 30_000 });
}

/** Invitee, step 1 (no session): the link's token is the only credential. */
export async function beginAcceptance(input: { token: unknown; principalName: unknown }, rpId: string) {
  const invitation = await resolve(input.token);
  const principalName = normalizePrincipalName(input.principalName);
  if (!principalName || principalName.length < 3) throw new InvitationError("INVALID_REQUEST", 400);
  const scope = { organizationId: invitation.organization_id, tenantId: invitation.tenant_id };
  const challenge = randomBytes(32).toString("base64url");
  const subject = await inTenant(scope, async (tx) => {
    if (!await localConnection(tx, scope)) throw new InvitationError("INVITATION_INVALID", 403);
    if (await tx.localIdentity.findFirst({ where: { ...scope, principalName }, select: { id: true } })) throw new InvitationError("IDENTIFIER_UNAVAILABLE", 409);
    const pending = await tx.invitation.updateMany({
      where: { ...scope, id: invitation.invitation_id, tokenHash: invitation.tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { pendingChallengeHash: sha256Hex(challenge), pendingExpiresAt: new Date(Date.now() + 600_000) },
    });
    if (pending.count !== 1) throw new InvitationError("INVITATION_INVALID", 403);
    return tx.subject.findFirstOrThrow({ where: { ...scope, id: invitation.subject_id }, select: { name: true } });
  });
  const organization = await rawPrisma.organization.findUniqueOrThrow({ where: { id: scope.organizationId }, select: { name: true, slug: true } });
  return {
    challenge, rp: { id: rpId, name: "LUXIA Identity" },
    user: { id: randomBytes(16).toString("base64url"), name: principalName, displayName: subject.name },
    organization,
  };
}

/** Invitee, step 2: one transaction. Tenant, person and role come from the invitation row only. */
export async function completeAcceptance(input: { token: unknown; principalName: unknown } & PasskeyRegistration, origin: { rpId: string; origin: string }) {
  const invitation = await resolve(input.token);
  const principalName = normalizePrincipalName(input.principalName);
  const challenge = typeof input.clientDataJSON === "string" ? registrationChallenge(input.clientDataJSON) : null;
  if (!principalName || principalName.length < 3 || !challenge) throw new InvitationError("INVALID_REQUEST", 400);
  let passkey: { credentialId: string; publicKeyPem: string };
  try { passkey = verifyPasskeyRegistration({ ...input, expectedChallenge: challenge, expectedOrigin: origin.origin, rpId: origin.rpId }); }
  catch { throw new InvitationError("PASSKEY_REGISTRATION_INVALID", 400); }
  const scope = { organizationId: invitation.organization_id, tenantId: invitation.tenant_id };
  try {
    return await inTenant(scope, async (tx) => {
      const now = new Date();
      const accepted = await tx.invitation.updateMany({
        where: { ...scope, id: invitation.invitation_id, tokenHash: invitation.tokenHash, acceptedAt: null, revokedAt: null,
          expiresAt: { gt: now }, pendingChallengeHash: sha256Hex(challenge), pendingExpiresAt: { gt: now } },
        data: { acceptedAt: now, pendingChallengeHash: null, pendingExpiresAt: null },
      });
      if (accepted.count !== 1) throw new InvitationError("INVITATION_INVALID", 403);
      const row = await tx.invitation.findFirstOrThrow({ where: { ...scope, id: invitation.invitation_id } });
      const subject = await tx.subject.findFirst({ where: { ...scope, id: row.subjectId } });
      if (!subject || subject.lifecycleState !== "PROVISIONING") throw new InvitationError("INVITATION_INVALID", 403);
      assertSubjectLifecycleTransition("PROVISIONING", "ACTIVE");
      await tx.subject.update({ where: { id: subject.id }, data: { lifecycleState: "ACTIVE", lifecycleVersion: { increment: 1 }, lifecycleChangedAt: now } });
      const connectionId = await localConnection(tx, scope);
      if (!connectionId) throw new InvitationError("INVITATION_INVALID", 403);
      await createPasskeyIdentity(tx, scope, { subjectId: subject.id, connectionId, principalName, passkey, rpId: origin.rpId, origin: origin.origin, actorSubjectId: subject.id });
      if (row.role === "ADMIN") {
        // The authority is the inviter's: it must still hold assignments.manage when the link is used.
        try { await requireNative(tx, { ...scope, subjectId: row.invitedBySubjectId }, "assignments.manage"); }
        catch { throw new InvitationError("INVITATION_INVALID", 403); }
        await grantAdministrator(tx, scope, { subjectId: subject.id, actorSubjectId: row.invitedBySubjectId, changePrefix: `invitation:${row.id}`, metadata: { invitationId: row.id } });
      }
      await tx.canonicalAdminAuditEvent.create({ data: { ...scope, actorSubjectId: subject.id, targetSubjectId: subject.id, operation: "INVITATION.ACCEPT",
        changeId: `invitation:${row.id}:accept`, result: "SUCCESS", metadata: { invitationId: row.id, role: row.role } } });
      const organization = await tx.organization.findUniqueOrThrow({ where: { id: scope.organizationId }, select: { slug: true } });
      return { organization: organization.slug };
    });
  } catch (error) {
    if (error instanceof InvitationError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || (error.code === "P2010" && (error.meta as { code?: string } | undefined)?.code === "23505")))
      throw new InvitationError("IDENTIFIER_UNAVAILABLE", 409);
    throw error;
  }
}
