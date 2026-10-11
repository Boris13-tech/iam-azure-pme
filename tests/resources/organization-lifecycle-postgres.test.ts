import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { SessionStore } from "../../lib/auth/session-store";
import { revokeSession } from "../../lib/admin/canonical-administration";
import { beginAcceptance, createInvitation } from "../../lib/onboarding/invitations";
import { addDomain } from "../../lib/onboarding/domains";
import { readOrganizationLifecycle, transitionOrganization, type OrganizationStatus } from "../../lib/organizations/lifecycle";
import { softwarePasskey } from "../helpers/software-passkey";

// First Admin / Break-glass v1, B3: organization lifecycle enforcement on PostgreSQL, through the real
// route handlers and library functions as app_user. Microsoft itself is not called.
vi.mock("../../lib/auth/providers/entra", () => ({
  beginEntraAuthentication: vi.fn(async () => ({
    transactionId: `state-${randomUUID()}`, kind: "REDIRECT",
    redirectUrl: "https://login.microsoftonline.com/test/oauth2/v2.0/authorize?state=x",
    continuation: { nonce: "nonce-test", codeVerifier: "verifier-test" },
  })),
}));
import { POST as begin } from "../../app/api/auth/local/begin/route";
import { POST as complete } from "../../app/api/auth/local/complete/route";
import { GET as entraLogin } from "../../app/auth/login/route";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const suffix = randomUUID().slice(0, 8);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const change = () => `b3:${randomUUID()}`;
let owner: PrismaClient;
let orgs = 0, ips = 0;

type Org = { slug: string; organizationId: string; tenantId: string; subjectId: string; accountId: string; local: string; principalName: string;
  passkey: ReturnType<typeof softwarePasskey> };
async function organization(): Promise<Org> {
  const organizationId = randomUUID(), tenantId = randomUUID(), slug = `life-${suffix}-${++orgs}`;
  await owner.organization.create({ data: { id: organizationId, name: "Lifecycle", slug } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const connect = async (providerType: "LUXIA_LOCAL" | "MICROSOFT_ENTRA") => {
    const connection = await owner.providerConnection.create({ data: { organizationId, providerType, externalScopeId: `${providerType}-${organizationId}`, name: providerType } });
    await owner.providerConnectionTenantScope.create({ data: { organizationId, tenantId, providerConnectionId: connection.id } });
    return connection.id;
  };
  const local = await connect("LUXIA_LOCAL");
  await connect("MICROSOFT_ENTRA");
  const subject = await owner.subject.create({ data: { organizationId, tenantId, type: "HUMAN", name: "Holder", lifecycleState: "ACTIVE" } });
  const account = await owner.identityAccount.create({ data: { organizationId, tenantId, subjectId: subject.id, providerConnectionId: local, externalObjectId: randomUUID() } });
  const principalName = `holder-${randomUUID().slice(0, 8)}`;
  const passkey = softwarePasskey();
  await owner.localIdentity.create({ data: { organizationId, tenantId, identityAccountId: account.id, principalName } });
  await owner.localAuthenticator.create({ data: { organizationId, tenantId, identityAccountId: account.id, type: "PASSKEY", credentialId: passkey.credentialId,
    publicKey: passkey.publicKeyPem, relyingPartyId: "localhost", allowedOrigin: "http://localhost:3000",
    credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY", algorithmId: "WEBAUTHN_ES256" } });
  return { slug, organizationId, tenantId, subjectId: subject.id, accountId: account.id, local, principalName, passkey };
}
const scope = (org: Org) => ({ organizationId: org.organizationId, tenantId: org.tenantId });
const signIn = (org: Org) => SessionStore.createSession({ ...scope(org), subjectId: org.subjectId, identityAccountId: org.accountId });
const transition = (org: Org, to: OrganizationStatus) => owner.$transaction((tx) => transitionOrganization(tx, org.organizationId, to));
const post = (handler: (request: Request) => Promise<Response>, path: string, body: unknown) =>
  handler(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": `203.0.113.${(++ips % 250) + 1}-${suffix}` }, body: JSON.stringify(body) }));
const shape = (value: Record<string, unknown>) => ({ keys: Object.keys(value).sort(), challenge: String(value.challenge).length, rpId: value.rpId,
  transactionId: /^[0-9a-f-]{36}$/.test(String(value.transactionId)), credentials: Array.isArray(value.allowCredentials) && value.allowCredentials.length === 0 });
const beginShape = async (organizationSlug: string, principalName: string) => {
  const response = await post(begin, "/api/auth/local/begin", { organization: organizationSlug, principalName });
  return { status: response.status, shape: shape(await response.json()) };
};
const entra = async (organizationSlug: string) => {
  const response = await entraLogin(new Request(`http://localhost:3000/auth/login?org=${organizationSlug}`, { headers: { "x-real-ip": `203.0.113.${(++ips % 250) + 1}-${suffix}` } }));
  return { status: response.status, location: response.headers.get("location") };
};

describe.runIf(enabled)("B3 organization lifecycle enforcement (app_user, PostgreSQL)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
  });
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("before authentication, SUSPENDED and CLOSED answer exactly like an unknown organization", async () => {
    const [suspended, closed] = [await organization(), await organization()];
    // A challenge obtained while ACTIVE cannot be completed after the suspension.
    const started = await post(begin, "/api/auth/local/begin", { organization: suspended.slug, principalName: suspended.principalName });
    const challenge = await started.json() as { transactionId: string; challenge: string };
    await transition(suspended, "SUSPENDED");
    await transition(closed, "CLOSED");
    const unknown = `unknown-${suffix}`;

    const reference = await beginShape(unknown, suspended.principalName);
    expect(reference.status).toBe(200);
    for (const org of [suspended, closed]) expect(await beginShape(org.slug, org.principalName), org.slug).toEqual(reference);
    const reference2 = await entra(unknown);
    expect(reference2.status).toBe(303);
    expect(new URL(reference2.location!).pathname + new URL(reference2.location!).search).toBe("/login?error=signin");
    for (const org of [suspended, closed]) expect(await entra(org.slug), org.slug).toEqual(reference2);

    const done = await post(complete, "/api/auth/local/complete", { organization: suspended.slug, transactionId: challenge.transactionId,
      challenge: challenge.challenge, ...suspended.passkey.assert(challenge.challenge) });
    expect(done.status).toBe(401);
    expect(await done.json()).toEqual({ error: "LOCAL_AUTHENTICATION_FAILED" });
    expect(done.headers.get("set-cookie")).toBeNull();
    expect(await owner.session.count({ where: { organizationId: suspended.organizationId } })).toBe(0);
  });

  it("an invitation of a SUSPENDED or CLOSED organization behaves like an unknown token", async () => {
    const org = await organization();
    const token = randomBytes(32).toString("base64url");
    const invitee = await owner.subject.create({ data: { ...scope(org), type: "HUMAN", name: "Invitee", lifecycleState: "PROVISIONING" } });
    await owner.$executeRaw`INSERT INTO "Invitation" ("id","organizationId","tenantId","subjectId","tokenHash","role","invitedBySubjectId","createdAt","expiresAt","updatedAt")
      VALUES (${randomUUID()}, ${org.organizationId}, ${org.tenantId}, ${invitee.id}, ${sha(token)}, 'MEMBER'::"InvitationRole", ${org.subjectId}, now(), now(), now())`;
    await transition(org, "SUSPENDED");
    const unknown = await beginAcceptance({ token: randomBytes(32).toString("base64url"), principalName: "someone" }, "localhost").catch((error) => error);
    const suspended = await beginAcceptance({ token, principalName: "someone" }, "localhost").catch((error) => error);
    expect(suspended).toMatchObject({ code: "INVITATION_INVALID", status: 403 });
    expect({ code: suspended.code, status: suspended.status }).toEqual({ code: unknown.code, status: unknown.status });
  });

  it("getSession uses the canonical resolver: a non-ACTIVE subject, a DISABLED account or a RECOVERY session resolve nothing", async () => {
    const org = await organization();
    const { rawToken, session } = await signIn(org);
    expect(await SessionStore.getSession(rawToken)).toMatchObject({ id: session.id, scope: "FULL" });
    // Changed directly (owner), without revoking the session, so only the resolver decides.
    await owner.$executeRaw`UPDATE "Subject" SET "lifecycleState" = 'SUSPENDED' WHERE "id" = ${org.subjectId}`;
    expect(await SessionStore.getSession(rawToken)).toBeNull();
    expect(await rawPrisma.$queryRaw<unknown[]>`SELECT * FROM resolve_session(${session.id})`).toEqual([]);
    await owner.$executeRaw`UPDATE "Subject" SET "lifecycleState" = 'ACTIVE' WHERE "id" = ${org.subjectId}`;
    expect(await SessionStore.getSession(rawToken)).toMatchObject({ id: session.id });
    await owner.$executeRaw`UPDATE "IdentityAccount" SET "status" = 'DISABLED', "disabledAt" = now() WHERE "id" = ${org.accountId}`;
    expect(await SessionStore.getSession(rawToken)).toBeNull();
    await owner.$executeRaw`UPDATE "IdentityAccount" SET "status" = 'ACTIVE', "disabledAt" = NULL WHERE "id" = ${org.accountId}`;
    const recoveryToken = randomBytes(32).toString("hex");
    await owner.session.create({ data: { id: sha(recoveryToken), ...scope(org), subjectId: org.subjectId, identityAccountId: org.accountId,
      scope: "RECOVERY", createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60_000) } });
    expect(await SessionStore.getSession(recoveryToken)).toBeNull(); // FULL only until B2
  });

  it("refresh and sign-out are conditional: a concurrent revocation is a no-op, never an error, and sign-out is recorded once", async () => {
    const org = await organization();
    const { rawToken, session } = await signIn(org);
    const results = await Promise.all([1, 2, 3].map(() => SessionStore.revokeByToken(rawToken, { signOutAudit: true })));
    expect(results.every((result) => result?.id === session.id)).toBe(true);
    expect(await owner.canonicalAdminAuditEvent.count({ where: { organizationId: org.organizationId, operation: "SESSION.SIGN_OUT" } })).toBe(1);
    const revoked = await owner.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(await SessionStore.touch(org.organizationId, org.tenantId, session.id)).toBe(false);
    expect(await owner.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(revoked);
    // Administrator revocation racing itself: one succeeds, the other is a clean 404.
    const second = await signIn(org);
    const auth = { ...scope(org), subjectId: org.subjectId };
    const outcomes = await Promise.all([revokeSession(auth, second.session.id, change()), revokeSession(auth, second.session.id, change())]
      .map((promise) => promise.then(() => "ok", (error: { code?: string }) => error.code)));
    expect(outcomes.sort()).toEqual(["ACTIVE_SESSION_NOT_FOUND", "ok"]);
  });

  it("suspension revokes every active session in the same transaction; reactivation never brings one back", async () => {
    const org = await organization();
    const signed = [await signIn(org), await signIn(org), await signIn(org)];
    const suspension = await transition(org, "SUSPENDED");
    expect(suspension).toMatchObject({ from: "ACTIVE", to: "SUSPENDED", revokedSessions: 3, before: { openSessions: 3 }, after: { openSessions: 0 } });
    expect(await readOrganizationLifecycle(owner, org.organizationId)).toMatchObject({ status: "SUSPENDED", openSessions: 0 });
    for (const { rawToken } of signed) expect(await SessionStore.getSession(rawToken)).toBeNull();
    await expect(signIn(org)).rejects.toMatchObject({ reason: "ORGANIZATION_NOT_ACTIVE" });
    const revokedAt = await owner.session.findMany({ where: { organizationId: org.organizationId }, select: { id: true, revokedAt: true }, orderBy: { id: "asc" } });

    const reactivation = await transition(org, "ACTIVE");
    expect(reactivation).toMatchObject({ from: "SUSPENDED", to: "ACTIVE", revokedSessions: 0, after: { openSessions: 0 } });
    expect(await owner.session.findMany({ where: { organizationId: org.organizationId }, select: { id: true, revokedAt: true }, orderBy: { id: "asc" } })).toEqual(revokedAt);
    for (const { rawToken } of signed) expect(await SessionStore.getSession(rawToken)).toBeNull();
    const fresh = await signIn(org);
    expect(await SessionStore.getSession(fresh.rawToken)).toMatchObject({ id: fresh.session.id });
  });

  it("closing is irreversible and releases what the organization held", async () => {
    const org = await organization();
    await signIn(org);
    await owner.$executeRaw`INSERT INTO "Invitation" ("id","organizationId","tenantId","subjectId","tokenHash","role","invitedBySubjectId","createdAt","expiresAt","updatedAt")
      VALUES (${randomUUID()}, ${org.organizationId}, ${org.tenantId}, ${org.subjectId}, ${sha(randomUUID())}, 'MEMBER'::"InvitationRole", ${org.subjectId}, now(), now(), now())`;
    await owner.organizationDomain.create({ data: { ...scope(org), domain: `closing-${suffix}.example`, status: "VERIFIED", verifiedAt: new Date(),
      challengeHash: sha(randomUUID()), challengeExpiresAt: new Date(Date.now() + 86_400_000) } });
    const closing = await transition(org, "CLOSED");
    expect(closing).toMatchObject({ to: "CLOSED", revokedSessions: 1, revokedInvitations: 1, releasedDomains: 1,
      after: { openSessions: 0, openInvitations: 0, heldDomains: 0 } });
    for (const to of ["ACTIVE", "SUSPENDED"] as const) await expect(transition(org, to)).rejects.toThrow(/ORGANIZATION_CLOSED/);
    expect(await readOrganizationLifecycle(owner, org.organizationId)).toMatchObject({ status: "CLOSED" });
    // The runtime role can never run a transition.
    const other = await organization();
    await expect(rawPrisma.$transaction((tx) => transitionOrganization(tx, other.organizationId, "SUSPENDED"))).rejects.toThrow(/ORGANIZATION_STATUS_OPERATOR_ONLY/);
  });

  it("authenticated writes refuse with an audited denial when the organization is not ACTIVE", async () => {
    const org = await organization();
    for (const key of ["subjects.create", "providers.manage"]) {
      const entitlement = await owner.entitlement.create({ data: { ...scope(org), key, resource: key.split(".")[0], action: key.split(".")[1] } });
      await owner.assignment.create({ data: { ...scope(org), subjectId: org.subjectId, entitlementId: entitlement.id, source: "DIRECT", sourceRef: "test" } });
    }
    await transition(org, "SUSPENDED");
    const auth = { ...scope(org), subjectId: org.subjectId };
    await expect(createInvitation(auth, change(), { name: "Someone", role: "MEMBER" })).rejects.toMatchObject({ code: "ORGANIZATION_NOT_ACTIVE" });
    await expect(addDomain(auth, change(), `suspended-${suffix}.example`)).rejects.toMatchObject({ code: "ORGANIZATION_NOT_ACTIVE" });
    const denied = await owner.canonicalAdminAuditEvent.findMany({ where: { organizationId: org.organizationId, result: "DENIED" }, select: { operation: true } });
    expect(denied.map((row) => row.operation).sort()).toEqual(["DOMAIN.ADD.DENIED", "INVITATION.CREATE.DENIED"]);
  });
});
