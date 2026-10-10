// Security Journal v1: app_user PostgreSQL / forced RLS certification of writes W1-W5, the unified
// journal (R1), self-service sessions and passkeys (R2, R3) and the dashboard sign-in widgets (R4).
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { SessionCreationDeniedError, SessionStore } from "../../lib/auth/session-store";
import { entraSignInEvidence, recordRejectedSignIn } from "../../lib/auth/sign-in-evidence";
import { listSecurityJournal, type JournalEntry } from "../../lib/audit/security-journal";
import { listMyAuthenticators, listMySessions, revokeMySession } from "../../lib/auth/self-service";
import { PrismaLocalIdentityStore } from "../../lib/provider-adapters/implementations/luxia-local/prisma-local-identity-store";
import { loadIdentitySecurityPosture } from "../../lib/dashboard/posture";
import type { Widget } from "../../lib/dashboard/posture-contract";

const org = randomUUID(), tenantA = randomUUID(), tenantB = randomUUID();
const A = { organizationId: org, tenantId: tenantA }, B = { organizationId: org, tenantId: tenantB };
const entra = randomUUID(), local = randomUUID();
const S = randomUUID(), X = randomUUID(), O = randomUUID(), SB = randomUUID();
const accS = randomUUID(), accSLocal = randomUUID(), accX = randomUUID(), accO = randomUUID(), accSB = randomUUID();
const MARK = { ip: `IP-${randomUUID()}`, ua: `UA-${randomUUID()}`, cred: `CRED-${randomUUID()}`, pub: `PUB-${randomUUID()}` };
let owner: PrismaClient;
const ident = (subjectId: string, identityAccountId: string, scope = A) => ({ ...scope, subjectId, identityAccountId, providerConnectionId: entra });
const sessionCtx = (subjectId: string, identityAccountId: string, scope = A) => ({ ...scope, subjectId, identityAccountId });
const readEvidence = (where: object) => withTenantDb(A, tx => tx.authenticationEvidence.findMany({ where }));
const FORBIDDEN_KEYS = /ipHash|userAgentHash|credentialId|publicKey|secretRef|evidenceDigest|signCount|rawToken|idToken|access_token/;

describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("Security Journal v1 — app_user PostgreSQL/RLS", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!(["localhost", "127.0.0.1"].includes(url.hostname) || (url.hostname === "ep-weathered-grass-ah5vrehj-pooler.c-3.us-east-1.aws.neon.tech" && ["/luxia_resources_diag_ci05"].includes(url.pathname)))) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL! } } });
    for (const scope of [A, B]) await owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${org}, true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${scope.tenantId}, true)`;
      if (scope === A) {
        await tx.organization.create({ data: { id: org, name: "Journal fixture" } });
        for (const id of [tenantA, tenantB]) await tx.tenant.create({ data: { id, organizationId: org, name: id === tenantA ? "Journal A" : "Journal B" } });
        await tx.providerConnection.create({ data: { id: entra, organizationId: org, providerType: "MICROSOFT_ENTRA", externalScopeId: randomUUID(), name: "Entra" } });
        await tx.providerConnection.create({ data: { id: local, organizationId: org, providerType: "LUXIA_LOCAL", externalScopeId: randomUUID(), name: "Local" } });
        await tx.subject.create({ data: { ...A, id: S, name: "Signed-in S", type: "HUMAN" } });
        await tx.subject.create({ data: { ...A, id: X, name: "Suspended X", type: "HUMAN", lifecycleState: "SUSPENDED" } });
        await tx.subject.create({ data: { ...A, id: O, name: "Other O", type: "HUMAN" } });
        await tx.identityAccount.create({ data: { ...A, id: accS, subjectId: S, providerConnectionId: entra, externalObjectId: randomUUID() } });
        await tx.identityAccount.create({ data: { ...A, id: accSLocal, subjectId: S, providerConnectionId: local, externalObjectId: randomUUID() } });
        await tx.identityAccount.create({ data: { ...A, id: accX, subjectId: X, providerConnectionId: entra, externalObjectId: randomUUID() } });
        await tx.identityAccount.create({ data: { ...A, id: accO, subjectId: O, providerConnectionId: entra, externalObjectId: randomUUID() } });
        await tx.localIdentity.create({ data: { ...A, identityAccountId: accSLocal, principalName: `s-${randomUUID()}` } });
        for (const key of ["audit.read"]) {
          const e = await tx.entitlement.create({ data: { ...A, key, action: "read", resource: "audit" } });
          await tx.assignment.create({ data: { ...A, subjectId: S, entitlementId: e.id, source: "DIRECT" } });
        }
      } else {
        await tx.subject.create({ data: { ...B, id: SB, name: "Tenant B person", type: "HUMAN" } });
        await tx.identityAccount.create({ data: { ...B, id: accSB, subjectId: SB, providerConnectionId: entra, externalObjectId: randomUUID() } });
      }
    }, { timeout: 120_000 });
  }, 180_000);
  afterAll(async () => { await owner?.$disconnect(); await rawPrisma.$disconnect(); });

  it("W1: Entra sign-in evidence is written atomically with the session, attested by the provider only (S1)", async () => {
    const { session } = await SessionStore.createSession(sessionCtx(S, accS), MARK.ip, MARK.ua, { evidence: entraSignInEvidence(ident(S, accS), "VERIFIED", "ENTRA_OIDC_VERIFIED") });
    const rows = await readEvidence({ subjectId: S, method: "FEDERATED_OIDC" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "VERIFIED", source: "EXTERNAL_PROVIDER", assuranceLevel: "LOW", userVerification: "PROVIDER_ASSERTED",
      phishingResistant: false, hardwareBound: false, identityAccountId: accS, reasonCode: "ENTRA_OIDC_VERIFIED" });
    expect(JSON.stringify(rows[0])).not.toContain(MARK.ip);
    expect(await withTenantDb(A, tx => tx.session.count({ where: { id: session.id } }))).toBe(1);
  });

  it("W1 fail closed: if the evidence cannot be written, no session exists", async () => {
    const before = await withTenantDb(A, tx => tx.session.count({ where: { subjectId: S } }));
    const broken = { ...entraSignInEvidence(ident(S, accS), "VERIFIED", "ENTRA_OIDC_VERIFIED"), assuranceProfileVersion: 0 }; // violates a DB check
    await expect(SessionStore.createSession(sessionCtx(S, accS), undefined, undefined, { evidence: broken })).rejects.toBeDefined();
    const mismatch = entraSignInEvidence(ident(O, accO), "VERIFIED", "ENTRA_OIDC_VERIFIED");
    await expect(SessionStore.createSession(sessionCtx(S, accS), undefined, undefined, { evidence: mismatch })).rejects.toThrow("SIGN_IN_EVIDENCE_MISMATCH");
    expect(await withTenantDb(A, tx => tx.session.count({ where: { subjectId: S } }))).toBe(before);
  });

  it("W2/W3: refusal of a known identity creates no session and one REJECTED evidence", async () => {
    await expect(SessionStore.createSession(sessionCtx(X, accX), undefined, undefined, { evidence: entraSignInEvidence(ident(X, accX), "VERIFIED", "ENTRA_OIDC_VERIFIED") }))
      .rejects.toBeInstanceOf(SessionCreationDeniedError);
    expect(await readEvidence({ subjectId: X })).toHaveLength(0);
    await recordRejectedSignIn(entraSignInEvidence(ident(X, accX), "REJECTED", "SUBJECT_NOT_ACTIVE"));
    const rows = await readEvidence({ subjectId: X });
    expect(rows.map(r => [r.outcome, r.reasonCode])).toEqual([["REJECTED", "SUBJECT_NOT_ACTIVE"]]);
    expect(await withTenantDb(A, tx => tx.session.count({ where: { subjectId: X } }))).toBe(0);
    await expect(recordRejectedSignIn(entraSignInEvidence(ident(X, accX), "VERIFIED", "X"))).rejects.toThrow("REJECTED_EVIDENCE_REQUIRED");
  });

  it("W4: sign-out is recorded once, atomically with the revocation", async () => {
    const { rawToken } = await SessionStore.createSession(sessionCtx(S, accS));
    await SessionStore.revokeByToken(rawToken, { signOutAudit: true });
    await SessionStore.revokeByToken(rawToken, { signOutAudit: true });
    const { rawToken: other } = await SessionStore.createSession(sessionCtx(S, accS));
    await SessionStore.revokeByToken(other); // no option: no journal entry (backward compatible)
    const events = await withTenantDb(A, tx => tx.canonicalAdminAuditEvent.findMany({ where: { operation: "SESSION.SIGN_OUT", actorSubjectId: S } }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ targetSubjectId: S, result: "SUCCESS", metadata: { providerType: "MICROSOFT_ENTRA" } });
  });

  it("W5: passkey enrolment is audited in the same transaction, without credential material", async () => {
    const id = randomUUID();
    await new PrismaLocalIdentityStore().saveAuthenticator({ ...A, providerConnectionId: local, operationId: randomUUID() }, {
      id, identityAccountId: accSLocal, type: "PASSKEY", status: "ACTIVE", credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY",
      credentialFormatVersion: 1, algorithmId: "WEBAUTHN_ES256", algorithmVersion: 1, keyId: id, keyVersion: 1, verifierPolicyVersion: 1,
      hardwareBound: true, userVerificationRequired: true, credentialId: MARK.cred, publicKey: MARK.pub, signCount: 0,
    }, { enrollmentAudit: { actorSubjectId: S } });
    const events = await withTenantDb(A, tx => tx.canonicalAdminAuditEvent.findMany({ where: { operation: "LOCAL_AUTHENTICATOR.ENROLL", actorSubjectId: S } }));
    expect(events).toHaveLength(1);
    expect(events[0].changeId).toBe(`enroll:${id}`);
    expect(JSON.stringify(events[0])).not.toMatch(new RegExp(`${MARK.cred}|${MARK.pub}`));
  });

  it("R1: unified journal merges sign-ins and admin events, hides consultations by default, paginates without loss", async () => {
    const auth = { ...A, subjectId: S };
    const page = await listSecurityJournal(auth, { limit: 100 });
    const kinds = new Set(page.entries.map(e => e.kind));
    expect(kinds).toEqual(new Set(["SIGN_IN", "ADMIN"]));
    expect(page.entries.some(e => e.action.endsWith(".READ"))).toBe(false);
    const entraIn = page.entries.find(e => e.kind === "SIGN_IN" && e.method === "FEDERATED_OIDC" && e.result === "SUCCESS")!;
    expect(entraIn).toMatchObject({ assurance: "PROVIDER_ATTESTED", actorName: "Signed-in S", providerType: "MICROSOFT_ENTRA" });
    const refused = page.entries.find(e => e.kind === "SIGN_IN" && e.result === "DENIED")!;
    expect(refused).toMatchObject({ reasonCode: "SUBJECT_NOT_ACTIVE", actorName: "Suspended X" });
    expect(JSON.stringify(page)).not.toMatch(FORBIDDEN_KEYS);
    const withReads = await listSecurityJournal(auth, { limit: 100, includeReads: true });
    expect(withReads.entries.some(e => e.action === "AUDIT.READ")).toBe(true);
    expect((await listSecurityJournal(auth, { limit: 100, kind: "sign-in" })).entries.every(e => e.kind === "SIGN_IN")).toBe(true);
    expect((await listSecurityJournal(auth, { limit: 100, kind: "admin" })).entries.every(e => e.kind === "ADMIN")).toBe(true);
    // Small pages walk the exact same sequence as one large page.
    const all = (await listSecurityJournal(auth, { limit: 100, includeReads: true })).entries;
    const walked: JournalEntry[] = []; let cursor: string | null = null; let guard = 0;
    do { const p = await listSecurityJournal(auth, { limit: 2, includeReads: true, cursor }); walked.push(...p.entries); cursor = p.nextCursor; } while (cursor && ++guard < 200);
    const key = (e: JournalEntry) => `${e.kind}:${e.id}`;
    const walkedKeys = walked.map(key);
    expect(new Set(walkedKeys).size).toBe(walkedKeys.length);
    // Every entry of the earlier full page is reached, in the same order (walking adds newer AUDIT.READ rows only on top).
    expect(all.map(key).every(k => walkedKeys.includes(k))).toBe(true);
    expect(walkedKeys.filter(k => all.map(key).includes(k))).toEqual(all.map(key));
  });

  it("R1: tenant isolation", async () => {
    await SessionStore.createSession(sessionCtx(SB, accSB, B), undefined, undefined, { evidence: entraSignInEvidence(ident(SB, accSB, B), "VERIFIED", "ENTRA_OIDC_VERIFIED") });
    const a = await listSecurityJournal({ ...A, subjectId: S }, { limit: 100, includeReads: true });
    expect(a.entries.some(e => e.actorName === "Tenant B person")).toBe(false);
    const b = await listSecurityJournal({ ...B, subjectId: SB }, { limit: 100 });
    expect(b.entries.map(e => e.actorName)).toEqual(["Tenant B person"]);
  });

  it("R2/R3: self-service sees and revokes only its own sessions; passkeys read only", async () => {
    const mine = await SessionStore.createSession(sessionCtx(S, accS));
    const others = await SessionStore.createSession(sessionCtx(O, accO));
    const auth = { sessionId: mine.session.id, ...A, subjectId: S, identityAccountId: accS };
    const sessions = await listMySessions(auth);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.filter(s => s.current)).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toMatch(/[0-9a-f]{64}/); // no stored session id/hash
    expect(JSON.stringify(sessions)).not.toContain(MARK.ip);
    const { sessionRef } = await import("../../lib/auth/self-service");
    await expect(revokeMySession(auth, sessionRef(others.session.id), `self:${randomUUID()}`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const target = sessions.find(s => !s.current)!;
    const changeId = `self:${randomUUID()}`;
    expect(await revokeMySession(auth, target.ref, changeId)).toEqual({ status: "REVOKED", current: false });
    await expect(revokeMySession(auth, target.ref, changeId)).rejects.toMatchObject({ code: "CHANGE_ALREADY_APPLIED" });
    await expect(revokeMySession(auth, target.ref, `self:${randomUUID()}`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await withTenantDb(A, tx => tx.session.count({ where: { id: others.session.id, revokedAt: null } }))).toBe(1);
    const audit = await withTenantDb(A, tx => tx.canonicalAdminAuditEvent.findMany({ where: { changeId } }));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operation: "SESSION.REVOKE", actorSubjectId: S, targetSubjectId: S, metadata: { selfService: true, current: false } });
    const keys = await listMyAuthenticators(auth);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every(k => Object.keys(k).sort().join() === "enrolledAt,hardwareBound,lastUsedAt,status,type")).toBe(true);
    expect(await listMyAuthenticators({ ...auth, subjectId: O, identityAccountId: accO })).toEqual([]);
    await expect(listMySessions({ ...auth, subjectId: X, identityAccountId: accX })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("R4: Entra widget becomes real only once recorded, labelled with its start date; sign-in widgets count real evidence", async () => {
    const r = await loadIdentitySecurityPosture({ sessionId: randomUUID(), ...A, subjectId: S, identityAccountId: accS });
    const w = (id: string) => Object.values(r.sections).flat().find(x => x.id === id) as Widget & { value?: unknown; since?: string };
    expect(w("auth.entraSignInEvidence")).toMatchObject({ state: "ok", value: { VERIFIED: expect.any(Number), REJECTED: 1 } });
    expect(Date.parse(w("auth.entraSignInEvidence").since!)).not.toBeNaN();
    expect((w("auth.signIns24hByMethod").value as Record<string, number>).FEDERATED_OIDC).toBeGreaterThanOrEqual(1);
    expect(w("auth.rejectedSignIns24h")).toMatchObject({ state: "ok", value: 1 });
    const rb = await loadIdentitySecurityPosture({ sessionId: randomUUID(), ...B, subjectId: SB, identityAccountId: accSB });
    expect(Object.values(rb.sections).flat().find(x => x.id === "auth.entraSignInEvidence")?.state).toBe("restricted"); // no audit.read in B
  });
});
