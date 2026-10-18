import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { SessionStore } from "../../lib/auth/session-store";
import { authorize } from "../../lib/auth/authorization-engine";
import { updateSubject } from "../../lib/admin/canonical-administration";
import { softwarePasskey } from "../helpers/software-passkey";
import { POST as begin } from "../../app/api/auth/local/begin/route";
import { POST as complete } from "../../app/api/auth/local/complete/route";

// Private Beta G1, "leaver" scenario: an administrator disables a person who leaves. Proven on PostgreSQL as
// app_user, through the real library functions and sign-in routes (Microsoft itself is not called):
// every open session ends at once, no new session opens by passkey or by Microsoft Entra, every access
// assignment is revoked, the change is journaled with its counts, colleagues are untouched, and a later
// reactivation brings back neither the sessions nor the accesses.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const suffix = randomUUID().slice(0, 8);
const change = () => `leaver:${randomUUID()}`;
let owner: PrismaClient;
let ips = 0;

type Person = { subjectId: string; localAccountId: string; entraAccountId: string; principalName: string; passkey: ReturnType<typeof softwarePasskey> };
type Org = { slug: string; organizationId: string; tenantId: string; local: string; entra: string };

async function organization(): Promise<Org> {
  const organizationId = randomUUID(), tenantId = randomUUID(), slug = `leaver-${suffix}-${randomUUID().slice(0, 4)}`;
  await owner.organization.create({ data: { id: organizationId, name: "Leaver", slug } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const connect = async (providerType: "LUXIA_LOCAL" | "MICROSOFT_ENTRA") => {
    const connection = await owner.providerConnection.create({ data: { organizationId, providerType, externalScopeId: `${providerType}-${organizationId}`, name: providerType } });
    await owner.providerConnectionTenantScope.create({ data: { organizationId, tenantId, providerConnectionId: connection.id } });
    return connection.id;
  };
  return { slug, organizationId, tenantId, local: await connect("LUXIA_LOCAL"), entra: await connect("MICROSOFT_ENTRA") };
}
const scope = (org: Org) => ({ organizationId: org.organizationId, tenantId: org.tenantId });

async function person(org: Org, name: string): Promise<Person> {
  const subject = await owner.subject.create({ data: { ...scope(org), type: "HUMAN", name, lifecycleState: "ACTIVE" } });
  const local = await owner.identityAccount.create({ data: { ...scope(org), subjectId: subject.id, providerConnectionId: org.local, externalObjectId: randomUUID() } });
  const entra = await owner.identityAccount.create({ data: { ...scope(org), subjectId: subject.id, providerConnectionId: org.entra, externalObjectId: randomUUID() } });
  const principalName = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const passkey = softwarePasskey();
  await owner.localIdentity.create({ data: { ...scope(org), identityAccountId: local.id, principalName } });
  await owner.localAuthenticator.create({ data: { ...scope(org), identityAccountId: local.id, type: "PASSKEY", credentialId: passkey.credentialId,
    publicKey: passkey.publicKeyPem, relyingPartyId: "localhost", allowedOrigin: "http://localhost:3000",
    credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY", algorithmId: "WEBAUTHN_ES256" } });
  return { subjectId: subject.id, localAccountId: local.id, entraAccountId: entra.id, principalName, passkey };
}

const post = (handler: (request: Request) => Promise<Response>, path: string, body: unknown) =>
  handler(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": `198.51.100.${(++ips % 250) + 1}-${suffix}` }, body: JSON.stringify(body) }));

/** A full passkey sign-in through the real routes. */
async function passkeySignIn(org: Org, who: Person) {
  const started = await post(begin, "/api/auth/local/begin", { organization: org.slug, principalName: who.principalName });
  const challenge = await started.json() as { transactionId: string; challenge: string };
  const done = await post(complete, "/api/auth/local/complete", { organization: org.slug, transactionId: challenge.transactionId,
    challenge: challenge.challenge, ...who.passkey.assert(challenge.challenge) });
  return { status: done.status, cookie: done.headers.get("set-cookie"), body: await done.json() };
}

describe.runIf(enabled)("Private Beta G1: a person who leaves is cut off at once (app_user, PostgreSQL)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
  });
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("disabling the person ends their sessions, blocks passkey and Entra sign-in, revokes their accesses, and is journaled", async () => {
    const org = await organization();
    const admin = await person(org, "Admin");
    const leaver = await person(org, "Leaver");
    const colleague = await person(org, "Colleague");
    const entitlement = await owner.entitlement.create({ data: { ...scope(org), key: "resources.read", resource: "resources", action: "read" } });
    const assignment = await owner.assignment.create({ data: { ...scope(org), subjectId: leaver.subjectId, entitlementId: entitlement.id, source: "DIRECT", sourceRef: "test" } });
    const leaverAuth = { ...scope(org), subjectId: leaver.subjectId };

    // Control: before leaving, every path works, so each refusal below comes from the leaver change.
    expect(await passkeySignIn(org, leaver)).toMatchObject({ status: 200 });
    const byPasskey = await SessionStore.createSession({ ...leaverAuth, identityAccountId: leaver.localAccountId });
    const byEntra = await SessionStore.createSession({ ...leaverAuth, identityAccountId: leaver.entraAccountId });
    const colleagueSession = await SessionStore.createSession({ ...scope(org), subjectId: colleague.subjectId, identityAccountId: colleague.localAccountId });
    for (const { rawToken } of [byPasskey, byEntra, colleagueSession]) expect(await SessionStore.getSession(rawToken)).not.toBeNull();
    expect((await authorize(leaverAuth, { action: "read", resource: "resources" })).allowed).toBe(true);
    const openBefore = await owner.session.count({ where: { subjectId: leaver.subjectId, revokedAt: null } });
    expect(openBefore).toBe(3); // the route sign-in, plus the passkey and Entra sessions

    // The administrator disables the leaver.
    const result = await updateSubject({ ...scope(org), subjectId: admin.subjectId }, leaver.subjectId, { lifecycleState: "DISABLED" }, change());
    expect(result).toMatchObject({ id: leaver.subjectId, lifecycleState: "DISABLED" });

    // 1. Every open session of the leaver ended in the same transaction, and resolves nothing.
    expect(await owner.session.count({ where: { subjectId: leaver.subjectId, revokedAt: null } })).toBe(0);
    for (const { rawToken } of [byPasskey, byEntra]) expect(await SessionStore.getSession(rawToken)).toBeNull();
    // 2. No new session, by passkey (through the routes) or by Microsoft Entra.
    const sessionsBefore = await owner.session.count({ where: { subjectId: leaver.subjectId } });
    const refused = await passkeySignIn(org, leaver);
    expect(refused).toMatchObject({ status: 401, cookie: null, body: { error: "LOCAL_AUTHENTICATION_FAILED" } });
    await expect(SessionStore.createSession({ ...leaverAuth, identityAccountId: leaver.entraAccountId })).rejects.toMatchObject({ reason: "SUBJECT_NOT_ACTIVE" });
    await expect(SessionStore.createSession({ ...leaverAuth, identityAccountId: leaver.localAccountId })).rejects.toMatchObject({ reason: "SUBJECT_NOT_ACTIVE" });
    expect(await owner.session.count({ where: { subjectId: leaver.subjectId } })).toBe(sessionsBefore);
    // 3. Every access assignment is revoked; the native engine denies.
    expect(await owner.assignment.findUniqueOrThrow({ where: { id: assignment.id } })).toMatchObject({ status: "REVOKED" });
    expect((await authorize(leaverAuth, { action: "read", resource: "resources" })).allowed).toBe(false);
    // 4. Journaled once, by the administrator, with the counts.
    const events = await owner.canonicalAdminAuditEvent.findMany({ where: { organizationId: org.organizationId, operation: "SUBJECT.UPDATE", targetSubjectId: leaver.subjectId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorSubjectId: admin.subjectId, result: "SUCCESS",
      metadata: expect.objectContaining({ lifecycleFrom: "ACTIVE", lifecycleTo: "DISABLED", revokedSessions: 3, revokedAssignments: 1 }) });
    // 5. Colleagues are untouched.
    expect(await SessionStore.getSession(colleagueSession.rawToken)).not.toBeNull();
    expect(await passkeySignIn(org, colleague)).toMatchObject({ status: 200 });
  });

  it("reactivating the person brings back neither their old sessions nor their accesses", async () => {
    const org = await organization();
    const admin = await person(org, "Admin");
    const leaver = await person(org, "Leaver");
    const entitlement = await owner.entitlement.create({ data: { ...scope(org), key: "resources.read", resource: "resources", action: "read" } });
    const assignment = await owner.assignment.create({ data: { ...scope(org), subjectId: leaver.subjectId, entitlementId: entitlement.id, source: "DIRECT", sourceRef: "test" } });
    const leaverAuth = { ...scope(org), subjectId: leaver.subjectId };
    const adminAuth = { ...scope(org), subjectId: admin.subjectId };
    const old = await SessionStore.createSession({ ...leaverAuth, identityAccountId: leaver.localAccountId });

    await updateSubject(adminAuth, leaver.subjectId, { lifecycleState: "DISABLED" }, change());
    await updateSubject(adminAuth, leaver.subjectId, { lifecycleState: "ACTIVE" }, change());

    expect(await SessionStore.getSession(old.rawToken)).toBeNull();
    expect(await owner.assignment.findUniqueOrThrow({ where: { id: assignment.id } })).toMatchObject({ status: "REVOKED" });
    expect((await authorize(leaverAuth, { action: "read", resource: "resources" })).allowed).toBe(false);
    // A fresh sign-in works again; the accesses must be granted again explicitly (no silent authority).
    expect(await passkeySignIn(org, leaver)).toMatchObject({ status: 200 });
  });
});
