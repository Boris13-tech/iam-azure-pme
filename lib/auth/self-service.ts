// Security Journal v1 (R2, R3): a signed-in person sees and manages only their own sessions and
// passkeys. Tenant RLS plus an explicit subjectId filter; nothing belonging to someone else is
// returned (404 for unknown references). Sessions are exposed through an opaque reference derived
// from the stored id, never the stored id/hash itself. No IP, user agent or credential material.
import { createHash } from "node:crypto";
import type { AuthContext } from "./auth-context";
import { CanonicalAdminError } from "../admin/canonical-administration";
import { withTenantDb } from "../db/scoped-client";

export const sessionRef = (storedId: string) =>
  createHash("sha256").update(`luxia-session-ref:${storedId}`, "utf8").digest("base64url").slice(0, 22);

export type MySession = Readonly<{ ref: string; createdAt: string; lastSeenAt: string | null; expiresAt: string;
  providerType: string; current: boolean }>;
export type MyAuthenticator = Readonly<{ type: string; status: string; enrolledAt: string; lastUsedAt: string | null; hardwareBound: boolean }>;

const scopeOf = (auth: AuthContext) => ({ organizationId: auth.organizationId, tenantId: auth.tenantId });

async function requireActiveSelf(tx: Parameters<Parameters<typeof withTenantDb>[1]>[0], auth: AuthContext) {
  const subject = await tx.subject.findFirst({ where: { ...scopeOf(auth), id: auth.subjectId, lifecycleState: "ACTIVE" }, select: { id: true } });
  if (!subject) throw new CanonicalAdminError("FORBIDDEN", 403);
}

async function activeOwnSessions(tx: Parameters<Parameters<typeof withTenantDb>[1]>[0], auth: AuthContext, now: Date) {
  return tx.session.findMany({ where: { ...scopeOf(auth), subjectId: auth.subjectId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" }, take: 200,
    select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true, identityAccount: { select: { providerConnection: { select: { providerType: true } } } } } });
}

export async function listMySessions(auth: AuthContext, now = new Date()): Promise<MySession[]> {
  return withTenantDb(scopeOf(auth), async tx => {
    await requireActiveSelf(tx, auth);
    return (await activeOwnSessions(tx, auth, now)).map(s => ({ ref: sessionRef(s.id), createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt?.toISOString() ?? null, expiresAt: s.expiresAt.toISOString(),
      providerType: s.identityAccount.providerConnection.providerType, current: s.id === auth.sessionId }));
  });
}

export async function revokeMySession(auth: AuthContext, ref: string, changeId: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(ref)) throw new CanonicalAdminError("NOT_FOUND", 404);
  return withTenantDb(scopeOf(auth), async tx => {
    await requireActiveSelf(tx, auth);
    if (await tx.canonicalAdminAuditEvent.findFirst({ where: { ...scopeOf(auth), changeId } })) throw new CanonicalAdminError("CHANGE_ALREADY_APPLIED", 409);
    const target = (await activeOwnSessions(tx, auth, now)).find(s => sessionRef(s.id) === ref);
    if (!target) throw new CanonicalAdminError("NOT_FOUND", 404);
    const updated = await tx.session.updateMany({ where: { ...scopeOf(auth), id: target.id, subjectId: auth.subjectId, revokedAt: null }, data: { revokedAt: now } });
    if (updated.count !== 1) throw new CanonicalAdminError("NOT_FOUND", 404);
    const current = target.id === auth.sessionId;
    await tx.canonicalAdminAuditEvent.create({ data: { ...scopeOf(auth), actorSubjectId: auth.subjectId, targetSubjectId: auth.subjectId,
      operation: "SESSION.REVOKE", result: "SUCCESS", changeId, metadata: { selfService: true, current } } });
    return { status: "REVOKED" as const, current };
  });
}

export async function listMyAuthenticators(auth: AuthContext): Promise<MyAuthenticator[]> {
  return withTenantDb(scopeOf(auth), async tx => {
    await requireActiveSelf(tx, auth);
    const accounts = await tx.identityAccount.findMany({ where: { ...scopeOf(auth), subjectId: auth.subjectId }, select: { id: true } });
    if (!accounts.length) return [];
    const rows = await tx.localAuthenticator.findMany({ where: { ...scopeOf(auth), identityAccountId: { in: accounts.map(a => a.id) } },
      orderBy: { enrolledAt: "desc" }, select: { type: true, status: true, enrolledAt: true, lastUsedAt: true, hardwareBound: true } });
    return rows.map(r => ({ type: r.type, status: r.status, enrolledAt: r.enrolledAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null, hardwareBound: r.hardwareBound }));
  });
}

