import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { LUXIA_ORG_ADMIN_V1 } from "../../lib/auth/native-role-catalog";
import { GOVERNANCE_ADMIN_V2 } from "../../lib/resources/admin-bundle";
import { addDomain, checkDomain, listDomains, type TxtResolver } from "../../lib/onboarding/domains";
import { createInvitation, listInvitations, revokeInvitation } from "../../lib/onboarding/invitations";
import { getOnboardingChecklist } from "../../lib/onboarding/checklist";
import { allowRequest } from "../../lib/security/rate-limit";
import { POST as acceptBegin } from "../../app/api/auth/invitation/begin/route";
import { POST as acceptComplete } from "../../app/api/auth/invitation/complete/route";
import { POST as loginBegin } from "../../app/api/auth/local/begin/route";
import { POST as loginComplete } from "../../app/api/auth/local/complete/route";
import { softwarePasskey } from "../helpers/software-passkey";

// Customer Self-Onboarding v1, steps 5 to 7 on PostgreSQL as app_user: DNS verification (fake
// resolver, real database rules), invitations through the real routes, and the checklist.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const suffix = randomUUID().slice(0, 8);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const change = () => `test:${randomUUID()}`;
let owner: PrismaClient;
let ip = 0;

type Org = { organizationId: string; tenantId: string; slug: string; admin: string; helper: string };
async function organization(name: string): Promise<Org> {
  const org = { organizationId: randomUUID(), tenantId: randomUUID(), slug: `${name}-${suffix}`, admin: randomUUID(), helper: randomUUID() };
  const scope = { organizationId: org.organizationId, tenantId: org.tenantId };
  await owner.organization.create({ data: { id: org.organizationId, name, slug: org.slug } });
  await owner.tenant.create({ data: { id: org.tenantId, organizationId: org.organizationId, name: "Production" } });
  const local = await owner.providerConnection.create({ data: { organizationId: org.organizationId, providerType: "LUXIA_LOCAL", externalScopeId: org.tenantId, name: "LUXIA Local" } });
  await owner.providerConnectionTenantScope.create({ data: { ...scope, providerConnectionId: local.id } });
  for (const id of [org.admin, org.helper]) await owner.subject.create({ data: { ...scope, id, type: "HUMAN", name: id === org.admin ? "Admin" : "Helper" } });
  // Admin: full catalog. Helper: may create people but not grant access (no assignments.manage).
  for (const key of [...LUXIA_ORG_ADMIN_V1.entitlements, ...GOVERNANCE_ADMIN_V2]) {
    const [resource, action] = key.split(".");
    const entitlement = await owner.entitlement.create({ data: { ...scope, key, resource, action } });
    await owner.assignment.create({ data: { ...scope, subjectId: org.admin, entitlementId: entitlement.id, source: "DIRECT", sourceRef: "test" } });
    if (["subjects.read", "subjects.create", "providers.read"].includes(key))
      await owner.assignment.create({ data: { ...scope, subjectId: org.helper, entitlementId: entitlement.id, source: "DIRECT", sourceRef: "test" } });
  }
  return org;
}
const as = (org: Org, subjectId = org.admin) => ({ organizationId: org.organizationId, tenantId: org.tenantId, subjectId });
const dns = (records: string[]): TxtResolver => async () => records.map(record => [record]);
const nxdomain: TxtResolver = async () => { throw Object.assign(new Error("not found"), { code: "ENOTFOUND" }); };
const call = async (handler: (request: Request) => Promise<Response>, path: string, body: unknown) => {
  const response = await handler(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": `192.0.2.${++ip}-${suffix}` }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
};
const tokenOf = (link: string) => link.split("#")[1];
async function accept(token: string, principalName: string, extra: Record<string, unknown> = {}) {
  const passkey = softwarePasskey();
  const begin = await call(acceptBegin, "/api/auth/invitation/begin", { token, principalName });
  if (begin.status !== 200) return { begin, passkey };
  const complete = await call(acceptComplete, "/api/auth/invitation/complete", { token, principalName, ...passkey.register(begin.body.challenge), ...extra });
  return { begin, complete, passkey };
}

describe.runIf(enabled)("Domains, invitations and checklist (app_user, PostgreSQL)", () => {
  let a: Org, b: Org;
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    a = await organization("alpha"); b = await organization("bravo");
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("requirements 10, 11: a random TXT challenge verifies a domain once, for one organization; revalidation frees it", async () => {
    const domain = `shared-${suffix}.example`;
    const addedA = await addDomain(as(a), change(), ` ${domain.toUpperCase()}. `);
    expect(addedA).toMatchObject({ domain, status: "PENDING", recordName: `_luxia-verification.${domain}` });
    expect(addedA.recordValue).toMatch(/^luxia-verification=[A-Za-z0-9_-]{43}$/);
    const stored = await owner.organizationDomain.findUniqueOrThrow({ where: { id: addedA.id } });
    expect(stored.challengeHash).toBe(sha(addedA.recordValue.split("=")[1]));
    expect(JSON.stringify(await listDomains(as(a), change()))).not.toContain(addedA.recordValue.split("=")[1]);

    await expect(checkDomain(as(a), change(), addedA.id, nxdomain)).rejects.toMatchObject({ code: "DOMAIN_RECORD_NOT_FOUND" });
    await expect(checkDomain(as(a), change(), addedA.id, dns(["luxia-verification=" + "x".repeat(43)]))).rejects.toMatchObject({ code: "DOMAIN_RECORD_NOT_FOUND" });
    await expect(checkDomain(as(a, a.helper), change(), addedA.id, dns([addedA.recordValue]))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await checkDomain(as(a), change(), addedA.id, dns(["v=spf1 -all", addedA.recordValue]))).toMatchObject({ status: "VERIFIED" });

    const addedB = await addDomain(as(b), change(), domain); // a pending claim is allowed
    await expect(checkDomain(as(b), change(), addedB.id, dns([addedB.recordValue]))).rejects.toMatchObject({ code: "DOMAIN_VERIFIED_ELSEWHERE" });
    expect(await checkDomain(as(a), change(), addedA.id, nxdomain)).toMatchObject({ status: "LOST" });
    expect(await checkDomain(as(b), change(), addedB.id, dns([addedB.recordValue]))).toMatchObject({ status: "VERIFIED" });
    const denied = await owner.canonicalAdminAuditEvent.count({ where: { organizationId: b.organizationId, operation: "DOMAIN.CHECK.DENIED" } });
    expect(denied).toBe(1);
    // Org A cannot see or check Org B's domain.
    expect((await listDomains(as(a), change())).map(row => row.id)).not.toContain(addedB.id);
    await expect(checkDomain(as(a), change(), addedB.id, dns([addedB.recordValue]))).rejects.toMatchObject({ code: "DOMAIN_NOT_FOUND" });
  });

  it("an expired challenge is refused and must be renewed; checks are rate limited per organization", async () => {
    const added = await addDomain(as(a), change(), `expiring-${suffix}.example`);
    await owner.organizationDomain.update({ where: { id: added.id }, data: { challengeExpiresAt: new Date(Date.now() - 1000) } });
    await expect(checkDomain(as(a), change(), added.id, dns([added.recordValue]))).rejects.toMatchObject({ code: "DOMAIN_CHALLENGE_EXPIRED" });
    expect((await owner.organizationDomain.findUniqueOrThrow({ where: { id: added.id } })).status).toBe("EXPIRED");
    const renewed = await addDomain(as(a), change(), `expiring-${suffix}.example`);
    expect(renewed.id).toBe(added.id);
    expect(renewed.recordValue).not.toBe(added.recordValue);
    await expect(addDomain(as(a), change(), "not a domain")).rejects.toMatchObject({ code: "INVALID_DOMAIN" });
    while (await allowRequest("dns-verify", `org:${a.organizationId}`)) { /* exhaust the window */ }
    await expect(checkDomain(as(a), change(), renewed.id, dns([renewed.recordValue]))).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("requirements 8, 9: a member invitation is a single-use opaque link; acceptance keeps its tenant, person and role", async () => {
    const created = await createInvitation(as(a), change(), { name: "Marie Membre", role: "MEMBER" });
    const token = created.token;
    const row = await owner.invitation.findUniqueOrThrow({ where: { id: created.invitation.id } });
    expect(row.tokenHash).toBe(sha(token));
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(7 * 86_400_000);
    expect(await owner.subject.findUniqueOrThrow({ where: { id: row.subjectId } })).toMatchObject({ lifecycleState: "PROVISIONING", name: "Marie Membre" });
    const events = await owner.canonicalAdminAuditEvent.findMany({ where: { organizationId: a.organizationId, operation: { startsWith: "INVITATION." } } });
    expect(JSON.stringify(events)).not.toContain(token);

    const { begin, complete, passkey } = await accept(token, "marie", { role: "ADMIN", tenantId: b.tenantId, organization: b.slug, subjectId: a.admin });
    expect(begin.body.organization).toEqual({ name: "alpha", slug: a.slug });
    expect(complete).toMatchObject({ status: 200, body: { status: "ACCEPTED", organization: a.slug } });
    expect(await owner.subject.findUniqueOrThrow({ where: { id: row.subjectId } })).toMatchObject({ lifecycleState: "ACTIVE" });
    expect(await owner.assignment.count({ where: { subjectId: row.subjectId } })).toBe(0);  // MEMBER: no access granted
    expect(await owner.identityAccount.count({ where: { subjectId: row.subjectId, tenantId: a.tenantId } })).toBe(1);
    expect(await owner.identityAccount.count({ where: { tenantId: b.tenantId, subjectId: row.subjectId } })).toBe(0);

    // Replay, at both steps.
    expect((await accept(token, "marie2")).begin.body).toEqual({ error: "INVITATION_INVALID" });
    // The invitee signs in to their organization only.
    const started = await call(loginBegin, "/api/auth/local/begin", { organization: a.slug, principalName: "marie" });
    expect(started.body.allowCredentials).toEqual([]); // finding F1: never listed
    const signedIn = await call(loginComplete, "/api/auth/local/complete", { organization: a.slug, transactionId: started.body.transactionId, challenge: started.body.challenge, ...passkey.assert(started.body.challenge) });
    expect(signedIn.status).toBe(200);
  });

  it("requirement 9: an administrator invitation needs assignments.manage, grants only the catalog, and the inviter must still hold that right", async () => {
    await expect(createInvitation(as(a, a.helper), change(), { name: "Escalade", role: "ADMIN" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await owner.canonicalAdminAuditEvent.count({ where: { organizationId: a.organizationId, actorSubjectId: a.helper, operation: "INVITATION.CREATE.DENIED" } })).toBe(1);
    const asMember = await createInvitation(as(a, a.helper), change(), { name: "Paul Membre", role: "MEMBER" });
    expect(asMember.invitation.role).toBe("MEMBER");

    const admin = await createInvitation(as(a), change(), { name: "Alice Admin", role: "ADMIN" });
    const accepted = await accept(admin.token, "alice");
    expect(accepted.complete?.status).toBe(200);
    const grants = await owner.assignment.findMany({ where: { subjectId: admin.invitation.subjectId, status: "ACTIVE" }, include: { entitlement: true } });
    expect(grants.map(row => row.entitlement.key).sort()).toEqual([...LUXIA_ORG_ADMIN_V1.entitlements, ...GOVERNANCE_ADMIN_V2].sort());
    const grantEvents = await owner.canonicalAdminAuditEvent.findMany({ where: { targetSubjectId: admin.invitation.subjectId, operation: { in: ["ROLE_BUNDLE.GRANT", "ROLE.GOVERNANCE.GRANT"] } } });
    expect(grantEvents.map(row => row.actorSubjectId)).toEqual([a.admin, a.admin]);

    // The inviter loses assignments.manage before the link is used: acceptance is refused, nothing is created.
    const late = await createInvitation(as(a), change(), { name: "Late Admin", role: "ADMIN" });
    await owner.assignment.updateMany({ where: { subjectId: a.admin, entitlement: { key: "assignments.manage" } }, data: { status: "REVOKED" } });
    try {
      const refused = await accept(late.token, "late");
      expect(refused.complete?.body).toEqual({ error: "INVITATION_INVALID" });
      expect(await owner.invitation.findUniqueOrThrow({ where: { id: late.invitation.id } })).toMatchObject({ acceptedAt: null });
      expect(await owner.subject.findUniqueOrThrow({ where: { id: late.invitation.subjectId } })).toMatchObject({ lifecycleState: "PROVISIONING" });
      expect(await owner.assignment.count({ where: { subjectId: late.invitation.subjectId } })).toBe(0);
    } finally {
      await owner.assignment.updateMany({ where: { subjectId: a.admin, entitlement: { key: "assignments.manage" } }, data: { status: "ACTIVE" } });
    }
  });

  it("revoked, expired, cross-organization and taken-identifier cases are refused", async () => {
    const revoked = await createInvitation(as(a), change(), { name: "Revoked Person", role: "MEMBER" });
    expect(await revokeInvitation(as(a), change(), revoked.invitation.id)).toEqual({ id: revoked.invitation.id, status: "REVOKED" });
    expect((await accept(revoked.token, "revoked")).begin.body).toEqual({ error: "INVITATION_INVALID" });
    await expect(revokeInvitation(as(a), change(), revoked.invitation.id)).rejects.toMatchObject({ code: "INVITATION_NOT_OPEN" });

    const expired = await createInvitation(as(a), change(), { name: "Expired Person", role: "MEMBER" });
    await owner.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`UPDATE "Invitation" SET "createdAt" = now() - interval '8 days', "expiresAt" = now() - interval '1 day' WHERE "id" = ${expired.invitation.id}`;
    });
    expect((await accept(expired.token, "expired")).begin.body).toEqual({ error: "INVITATION_INVALID" });
    expect((await listInvitations(as(a), change())).find(row => row.id === expired.invitation.id)?.status).toBe("EXPIRED");

    const foreign = await createInvitation(as(b), change(), { name: "Bravo Person", role: "MEMBER" });
    await expect(revokeInvitation(as(a), change(), foreign.invitation.id)).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });
    expect((await listInvitations(as(a), change())).map(row => row.id)).not.toContain(foreign.invitation.id);

    const taken = await createInvitation(as(a), change(), { name: "Duplicate Marie", role: "MEMBER" });
    expect((await accept(taken.token, "marie")).begin.body).toEqual({ error: "IDENTIFIER_UNAVAILABLE" });
    expect((await accept("x".repeat(43), "nobody")).begin.body).toEqual({ error: "INVITATION_INVALID" });
  });

  it("step 7: the checklist reflects real data only", async () => {
    const fresh = await organization("charlie");
    expect(await getOnboardingChecklist(as(fresh), change())).toEqual({
      domainVerified: false, secondAdministrator: false, teamInvited: true, firstResource: false, firstAccessReview: false,
    }); // two people already exist in the fixture (admin and helper)
    const added = await addDomain(as(fresh), change(), `charlie-${suffix}.example`);
    await checkDomain(as(fresh), change(), added.id, dns([added.recordValue]));
    const second = await createInvitation(as(fresh), change(), { name: "Second Admin", role: "ADMIN" });
    expect((await accept(second.token, "second")).complete?.status).toBe(200);
    expect(await getOnboardingChecklist(as(fresh), change())).toMatchObject({ domainVerified: true, secondAdministrator: true });
    await expect(getOnboardingChecklist(as(fresh, randomUUID()), change())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
