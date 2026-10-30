// R7 (docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md): erasure of a CLOSED organization by the operator
// procedure, on PostgreSQL with the real guards. Every row of every table that carries it goes; every other
// organization is byte-identical; the journal and the other guards still refuse every DELETE outside it.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { SessionStore } from "../../lib/auth/session-store";
import { entraSignInEvidence } from "../../lib/auth/sign-in-evidence";
import { applyBreakGlass, planBreakGlass, type DnsCheck } from "../../lib/operators/break-glass";
import { applyErasure, ERASURE_TABLES, planErasure } from "../../lib/operators/organization-erasure";
import { softwarePasskey } from "../helpers/software-passkey";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261023140000_organization_erasure";
const ROLLBACK = "docs/operations/ORGANIZATION-ERASURE-ROLLBACK.sql";
const suffix = randomUUID().slice(0, 8);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const TOOL = "e".repeat(40);
const target = { host: "localhost", database: "ci", role: "ci" };
const absent: DnsCheck = async () => "ABSENT";
let owner: PrismaClient;
let orgs = 0;

type Org = { slug: string; organizationId: string; tenantId: string; local: string; subjectId: string; accountId: string };
/** Tables whose DELETE guard carries the erasure gate; the fixture holds a row in each, so each gate really runs. */
const GATED_ROWS = { Invitation: 1, OrganizationDomain: 1, LocalRecoveryCode: 1, ProviderSecretReference: 1, AccessReviewCampaign: 1, AccessReviewItem: 1 };
async function organization(): Promise<Org> {
  const organizationId = randomUUID(), tenantId = randomUUID(), slug = `r7-${suffix}-${++orgs}`;
  const scope = { organizationId, tenantId };
  await owner.organization.create({ data: { id: organizationId, name: "R7 erasure test", slug } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const local = await owner.providerConnection.create({ data: { organizationId, providerType: "LUXIA_LOCAL", externalScopeId: `local-${organizationId}`, name: "LUXIA Local" } });
  await owner.providerConnectionTenantScope.create({ data: { organizationId, tenantId, providerConnectionId: local.id } });
  const subject = await owner.subject.create({ data: { ...scope, type: "HUMAN", name: "Founder", lifecycleState: "ACTIVE" } });
  const account = await owner.identityAccount.create({ data: { ...scope, subjectId: subject.id, providerConnectionId: local.id, externalObjectId: randomUUID() } });
  await owner.localIdentity.create({ data: { ...scope, identityAccountId: account.id, principalName: `founder-${randomUUID().slice(0, 6)}` } });
  const key = softwarePasskey();
  await owner.localAuthenticator.create({ data: { ...scope, identityAccountId: account.id, type: "PASSKEY", credentialId: key.credentialId, publicKey: key.publicKeyPem,
    relyingPartyId: "localhost", allowedOrigin: "http://localhost:3000", credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY", algorithmId: "WEBAUTHN_ES256" } });
  const entitlement = await owner.entitlement.create({ data: { ...scope, key: "assignments.manage", resource: "assignments", action: "manage" } });
  const assignment = await owner.assignment.create({ data: { ...scope, subjectId: subject.id, entitlementId: entitlement.id, source: "DIRECT", sourceRef: "r7-test" } });
  const reviewer = await owner.subject.create({ data: { ...scope, type: "HUMAN", name: "Reviewer", lifecycleState: "ACTIVE" } });
  const invitee = await owner.subject.create({ data: { ...scope, type: "HUMAN", name: "Invitee", lifecycleState: "PROVISIONING" } });
  await owner.invitation.create({ data: { ...scope, subjectId: invitee.id, tokenHash: sha(randomUUID()), role: "MEMBER", invitedBySubjectId: subject.id } });
  await owner.organizationDomain.create({ data: { ...scope, domain: `r7-${randomUUID().slice(0, 8)}.example`, challengeHash: sha(randomUUID()), challengeExpiresAt: new Date(Date.now() + 60_000) } });
  await owner.localRecoveryCode.create({ data: { ...scope, identityAccountId: account.id, codeHash: sha(randomUUID()), batchId: randomUUID() } });
  await owner.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${organizationId}:${tenantId}`}, 0))::text`;
    await tx.providerSecretReference.create({ data: { organizationId, providerConnectionId: local.id, purpose: "OIDC_CLIENT", store: "azure-key-vault", locator: "akv://luxia-app-kv/oidc-conn", activeVersion: "a".repeat(32) } });
  });
  const reviewScope = await owner.resourceScope.create({ data: { ...scope, key: "r7-tenant", kind: "TENANT" } });
  const campaign = await owner.accessReviewCampaign.create({ data: { ...scope, name: "R7", scopeId: reviewScope.id, scopeType: "TENANT", reviewerSubjectId: reviewer.id, createdBySubjectId: subject.id, startsAt: new Date(), dueAt: new Date(Date.now() + 86_400_000) } });
  await owner.accessReviewItem.create({ data: { ...scope, campaignId: campaign.id, subjectId: subject.id, assignmentId: assignment.id, entitlementId: entitlement.id, scopeId: reviewScope.id,
    resourceIds: [randomUUID()], assignmentVersion: new Date(), entitlementVersion: new Date(), reviewerSubjectId: reviewer.id } });
  const org = { slug, organizationId, tenantId, local: local.id, subjectId: subject.id, accountId: account.id };
  // Product rows: two sessions with their sign-in evidence, a challenge, a Microsoft transaction, the signup code.
  for (let i = 0; i < 2; i++) await SessionStore.createSession({ ...scope, subjectId: subject.id, identityAccountId: account.id }, undefined, undefined,
    { evidence: entraSignInEvidence({ ...scope, subjectId: subject.id, identityAccountId: account.id, providerConnectionId: local.id }, "VERIFIED", "R7_TEST") });
  await owner.localAuthChallenge.create({ data: { ...scope, identityAccountId: account.id, purpose: "AUTHENTICATION", challengeHash: sha(randomUUID()), expiresAt: new Date(Date.now() + 60_000) } });
  await owner.authTransaction.create({ data: { id: randomUUID(), stateHash: sha(randomUUID()), nonce: "n", codeVerifier: "v", expectedOrganizationId: organizationId,
    expectedTenantId: tenantId, expectedProviderConnectionId: local.id, expiresAt: new Date(Date.now() + 60_000) } });
  const now = new Date();
  await owner.signupCode.create({ data: { codeHash: sha(randomUUID()), issuedBy: "ci", status: "CONSUMED", consumedAt: now, organizationId, createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000) } });
  return org;
}
const customer = () => ({ type: "VERIFIED_CUSTOMER_REQUEST", id: `REQ-${randomUUID().slice(0, 8)}`,
  requester: { name: "Jeanne Martin", role: "Directrice générale", channel: "Courrier signé" },
  verificationMethods: ["CALLBACK_KNOWN_CONTACT", "SIGNED_LETTER_OR_CONTRACT"], documentSha256: sha(randomUUID()), requestedActions: ["CLOSE_ORGANIZATION"] });
async function close(org: Org) {
  const input = { action: "CLOSE_ORGANIZATION", organization: org.slug, reason: "Fin du pilote (test R7)", reference: customer() };
  const opts = { issuedAt: new Date(Math.floor(Date.now() / 1000) * 1000), toolVersion: "test-tool-version", dns: absent, certificationOrganizations: [org.slug] };
  const { digest } = await planBreakGlass(owner, input, opts);
  await applyBreakGlass(owner, input, { ...opts, confirm: digest, irreversible: org.slug });
}
/** Every row of an organization, per table, as one digest: proves another organization is byte-identical. */
async function fingerprint(organizationId: string) {
  const out: Record<string, string> = {};
  for (const table of [...ERASURE_TABLES, "Organization", "AuthTransaction"]) {
    const column = table === "Organization" ? "id" : table === "AuthTransaction" ? "expectedOrganizationId" : "organizationId";
    const [row] = await owner.$queryRawUnsafe<Array<{ digest: string | null; n: number }>>(
      `SELECT md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)) AS digest, count(*)::int AS n FROM "${table}" t WHERE "${column}" = $1`, organizationId);
    out[table] = `${row.n}:${row.digest ?? "-"}`;
  }
  return out;
}
/** Rows left for an organization in every table that has an organizationId column (found in the catalog, not from the code's list). */
async function remaining(organizationId: string) {
  const tables = await owner.$queryRaw<Array<{ table_name: string }>>`
    SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'organizationId' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'OrganizationErasure'`;
  let total = 0;
  for (const { table_name } of tables) {
    const [row] = await owner.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table_name}" WHERE "organizationId" = $1`, organizationId);
    total += row.n;
  }
  const [org] = await owner.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "Organization" WHERE "id" = ${organizationId}`;
  const [tx] = await owner.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "AuthTransaction" WHERE "expectedOrganizationId" = ${organizationId}`;
  return { tables: tables.length, rows: total + org.n + tx.n };
}
const codeOf = (promise: Promise<unknown>) => promise.then(() => "OK", (error: { message?: string }) => /[A-Z][A-Z_]{5,}/.exec(String(error.message))?.[0] ?? String(error.message));

function psql(url: string, args: string[]) {
  const t = new URL(url); t.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", t.toString(), ...args], { encoding: "utf8" });
}
function psqlOk(url: string, args: string[]) {
  const result = psql(url, args);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout;
}

describe.runIf(enabled)("R7: erasure of a CLOSED organization (owner procedure, PostgreSQL)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
  });
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("erases exactly the closed organization, every table, and leaves another organization byte-identical", async () => {
    const a = await organization(), b = await organization();
    // Refused while the organization is not CLOSED, by the plan and by the database.
    expect(await codeOf(planErasure(owner, a.slug, target, TOOL))).toBe("ORGANIZATION_NOT_CLOSED");
    expect(await codeOf(owner.$queryRaw`SELECT luxia_organization_erase(${a.organizationId})`)).toBe("ERASURE_ORGANIZATION_NOT_CLOSED");
    await close(a);
    const journal = await owner.canonicalAdminAuditEvent.count({ where: { organizationId: a.organizationId } });
    expect(journal).toBeGreaterThan(0);
    const before = await fingerprint(b.organizationId);

    // Outside the erasure, the guards are unchanged, even for the owner and even with the marker forged.
    expect(await codeOf(owner.$executeRawUnsafe(`DELETE FROM "CanonicalAdminAuditEvent" WHERE "organizationId" = $1`, a.organizationId))).toBe("AUDIT_APPEND_ONLY");
    expect(await codeOf(owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('luxia.erasure_organization', ${b.organizationId}, true)`;
      await tx.$executeRawUnsafe(`DELETE FROM "AuthenticationEvidence" WHERE "organizationId" = $1`, b.organizationId);
    }))).toBe("AUDIT_APPEND_ONLY");
    expect(await codeOf(owner.$executeRawUnsafe(`TRUNCATE "CanonicalAdminAuditEvent"`))).toBe("AUDIT_APPEND_ONLY");
    // The runtime role can call neither function.
    expect(await codeOf(rawPrisma.$queryRaw`SELECT luxia_organization_erase(${a.organizationId})`)).toMatch(/permission denied|42501/i);
    expect(await codeOf(rawPrisma.$queryRawUnsafe(`SELECT luxia_erasure_allowed($1, 0::oid)`, a.organizationId))).toMatch(/permission denied|42501/i);

    const { plan } = await planErasure(owner, a.slug, target, TOOL);
    expect(plan.counts).toMatchObject({ Session: 2, AuthenticationEvidence: 2, LocalAuthChallenge: 1, AuthTransaction: 1, SignupCode: 1, Organization: 1,
      CanonicalAdminAuditEvent: journal, ProviderConnection: 1, Tenant: 1, ...GATED_ROWS });
    const result = await applyErasure(owner, plan);
    expect(result.counts).toEqual(plan.counts);
    const left = await remaining(a.organizationId);
    expect(left.tables).toBeGreaterThanOrEqual(ERASURE_TABLES.length);
    expect(left.rows).toBe(0);
    expect(await owner.organizationErasure.findUniqueOrThrow({ where: { organizationId: a.organizationId } })).toMatchObject({ counts: plan.counts });
    expect(await fingerprint(b.organizationId)).toEqual(before);
    // The marker does not outlive the erasure: another organization's append-only rows (it has two) stay protected.
    expect(await owner.authenticationEvidence.count({ where: { organizationId: b.organizationId } })).toBe(2);
    expect(await codeOf(owner.$executeRawUnsafe(`DELETE FROM "AuthenticationEvidence" WHERE "organizationId" = $1`, b.organizationId))).toBe("AUDIT_APPEND_ONLY");
  }, 120_000);

  it("a plan made stale by any new row is refused, and nothing is deleted", async () => {
    const c = await organization();
    await close(c);
    // Attack: the runtime role sets the marker for a CLOSED organization and reaches a DELETE through a SECURITY
    // DEFINER function owned by the table owner. current_user is then the owner, session_user is not: refused.
    const probe = `r7_probe_${suffix}`;
    await owner.$executeRawUnsafe(`CREATE FUNCTION ${probe}(p TEXT) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
      AS $$ DELETE FROM "AuthenticationEvidence" WHERE "organizationId" = p $$`);
    try {
      await owner.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION ${probe}(TEXT) TO app_user`);
      expect(await owner.authenticationEvidence.count({ where: { organizationId: c.organizationId } })).toBe(2);
      expect(await codeOf(rawPrisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('luxia.erasure_organization', ${c.organizationId}, true)`;
        await tx.$executeRawUnsafe(`SELECT ${probe}($1)`, c.organizationId);
      }))).toBe("AUDIT_APPEND_ONLY");
      expect(await owner.authenticationEvidence.count({ where: { organizationId: c.organizationId } })).toBe(2);
    } finally {
      await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${probe}(TEXT)`);
    }
    const { plan } = await planErasure(owner, c.slug, target, TOOL);
    await owner.authTransaction.create({ data: { id: randomUUID(), stateHash: sha(randomUUID()), nonce: "n", codeVerifier: "v", expectedOrganizationId: c.organizationId,
      expectedTenantId: c.tenantId, expectedProviderConnectionId: c.local, expiresAt: new Date(Date.now() + 60_000) } });
    const before = await fingerprint(c.organizationId);
    expect(await codeOf(applyErasure(owner, plan))).toBe("PLAN_STALE");
    expect(await fingerprint(c.organizationId)).toEqual(before);
    const fresh = await planErasure(owner, c.slug, target, TOOL);
    expect((await applyErasure(owner, fresh.plan)).counts.AuthTransaction).toBe(2);
    expect((await remaining(c.organizationId)).rows).toBe(0);
  }, 120_000);

  it("an organization with a bridge is refused by the plan and by the database: nothing goes, the link stays", async () => {
    const e = await organization();
    const user = await owner.user.create({ data: { email: `r7-${randomUUID()}@example.test`, name: "Legacy person" } });
    await owner.legacyUserBridge.create({ data: { legacyUserId: user.id, organizationId: e.organizationId, subjectId: e.subjectId } });
    await owner.auditLog.create({ data: { actorId: user.id, action: "LEGACY", ip: "198.51.100.1" } });
    await close(e);
    const before = await fingerprint(e.organizationId);
    expect(await codeOf(planErasure(owner, e.slug, target, TOOL))).toBe("LEGACY_DATA_PRESENT");
    expect(await codeOf(owner.$queryRaw`SELECT luxia_organization_erase(${e.organizationId})`)).toBe("ERASURE_LEGACY_DATA_PRESENT");
    expect(await fingerprint(e.organizationId)).toEqual(before);
    expect(await owner.legacyUserBridge.count({ where: { legacyUserId: user.id } })).toBe(1);
    expect(await owner.auditLog.count({ where: { actorId: user.id } })).toBe(1);
    expect(await owner.organizationErasure.count({ where: { organizationId: e.organizationId } })).toBe(0);
  }, 120_000);

  it("a bridge committed while apply runs stops the erasure: it is never deleted, everything rolls back", async () => {
    const i = await organization();
    await close(i);
    const { plan } = await planErasure(owner, i.slug, target, TOOL);
    const user = await owner.user.create({ data: { email: `r7-${randomUUID()}@example.test`, name: "Legacy person" } });
    let inserted!: () => void, commit!: () => void;
    const isInserted = new Promise<void>((resolve) => { inserted = resolve; });
    const committing = new Promise<void>((resolve) => { commit = resolve; });
    const late = owner.$transaction(async (tx) => {
      await tx.legacyUserBridge.create({ data: { legacyUserId: user.id, organizationId: i.organizationId, subjectId: i.subjectId } });
      inserted();
      await committing;
    }, { timeout: 30_000 });
    await isInserted;
    const before = await fingerprint(i.organizationId);
    const apply = codeOf(applyErasure(owner, plan));
    expect(await stillWaiting(apply)).toBe(STILL_WAITING); // the erasure reaches the Subject the bridge holds
    commit();
    await late;
    expect(await apply).not.toBe("OK");
    expect(await fingerprint(i.organizationId)).toEqual(before);
    expect(await owner.legacyUserBridge.count({ where: { legacyUserId: user.id } })).toBe(1);
    expect(await owner.organizationErasure.count({ where: { organizationId: i.organizationId } })).toBe(0);
  }, 120_000);

  it("a legacy user with no bridge does not block an erasure, stays, and is reported by plan and apply", async () => {
    const j = await organization();
    await close(j);
    const orphan = await owner.user.create({ data: { email: `r7-${randomUUID()}@example.test`, name: "Unlinked person" } });
    const total = await owner.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "User" u WHERE NOT EXISTS (SELECT 1 FROM "LegacyUserBridge" b WHERE b."legacyUserId" = u."id")`);
    const { plan } = await planErasure(owner, j.slug, target, TOOL);
    expect(plan.legacy).toEqual({ bridgesForOrganization: 0, usersWithoutBridge: total[0].n });
    const result = await applyErasure(owner, plan);
    expect(result.legacyUsersWithoutBridge).toBe(total[0].n);
    expect((await remaining(j.organizationId)).rows).toBe(0);
    expect(await owner.user.count({ where: { id: orphan.id } })).toBe(1);
  }, 120_000);

  const journalEvent = (org: Org) => ({ organizationId: org.organizationId, tenantId: org.tenantId, actorSubjectId: org.subjectId, operation: "SESSION.SIGN_OUT", result: "SUCCESS" as const, changeId: `r7:${randomUUID()}`, metadata: {} });
  const STILL_WAITING = "STILL_WAITING";
  const stillWaiting = (promise: Promise<unknown>) => Promise.race([promise.then(() => "SETTLED", () => "SETTLED"), new Promise((resolve) => setTimeout(() => resolve(STILL_WAITING), 700))]);

  it("a runtime INSERT during the erasure waits, then fails; the erasure stands", async () => {
    const f = await organization();
    await close(f);
    let erased!: () => void, finish!: () => void;
    const isErased = new Promise<void>((resolve) => { erased = resolve; });
    const finishing = new Promise<void>((resolve) => { finish = resolve; });
    const erasure = owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT luxia_organization_erase(${f.organizationId})`;
      erased();
      await finishing;
    }, { timeout: 30_000 });
    await isErased;
    const late = codeOf(rawPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${f.organizationId}, true), set_config('app.tenant_id', ${f.tenantId}, true)`;
      await tx.canonicalAdminAuditEvent.create({ data: journalEvent(f) });
    }, { timeout: 30_000 }));
    expect(await stillWaiting(late)).toBe(STILL_WAITING);
    finish();
    await erasure;
    expect(await late).not.toBe("OK");
    expect((await remaining(f.organizationId)).rows).toBe(0);
  }, 120_000);

  it("a runtime INSERT in flight when apply starts: the result differs from the plan, nothing is deleted", async () => {
    const g = await organization();
    await close(g);
    const { plan } = await planErasure(owner, g.slug, target, TOOL);
    let inserted!: () => void, commit!: () => void;
    const isInserted = new Promise<void>((resolve) => { inserted = resolve; });
    const committing = new Promise<void>((resolve) => { commit = resolve; });
    const flight = rawPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${g.organizationId}, true), set_config('app.tenant_id', ${g.tenantId}, true)`;
      await tx.canonicalAdminAuditEvent.create({ data: journalEvent(g) });
      inserted();
      await committing;
    }, { timeout: 30_000 });
    await isInserted;
    const apply = codeOf(applyErasure(owner, plan));
    expect(await stillWaiting(apply)).toBe(STILL_WAITING); // waits on the lock the insert holds on the organization row
    commit();
    await flight;
    expect(await apply).toBe("ERASURE_RESULT_MISMATCH");
    expect(await owner.organizationErasure.count({ where: { organizationId: g.organizationId } })).toBe(0);
    expect(await owner.canonicalAdminAuditEvent.count({ where: { organizationId: g.organizationId } })).toBe(plan.counts.CanonicalAdminAuditEvent + 1);
    expect(await owner.organization.count({ where: { id: g.organizationId } })).toBe(1);
  }, 120_000);

  it("a table added later that holds a row of the organization: ERASURE_INCOMPLETE, everything rolls back, no record", async () => {
    const h = await organization();
    await close(h);
    const { plan } = await planErasure(owner, h.slug, target, TOOL);
    const extra = `r7_extra_${suffix}`;
    await owner.$executeRawUnsafe(`CREATE TABLE "${extra}" ("organizationId" TEXT NOT NULL)`);
    try {
      await owner.$executeRawUnsafe(`INSERT INTO "${extra}" VALUES ($1)`, h.organizationId);
      const before = await fingerprint(h.organizationId);
      expect(await codeOf(applyErasure(owner, plan))).toBe("ERASURE_INCOMPLETE");
      expect(await fingerprint(h.organizationId)).toEqual(before);
      expect(await owner.organizationErasure.count({ where: { organizationId: h.organizationId } })).toBe(0);
    } finally {
      await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "${extra}"`);
    }
  }, 120_000);

  it("an owner that is not a superuser erases with BYPASSRLS, and is refused without it (Production-like role, scratch database)", async () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_r7_owner_${suffix}`, role = `luxia_r7_owner_${suffix}`, password = randomUUID();
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    psqlOk(admin, ["-c", `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD '${password}'`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const superuser = scratch.toString();
    const asOwner = new URL(superuser); asOwner.username = role; asOwner.password = password;
    const client = new PrismaClient({ datasources: { db: { url: asOwner.toString() } } });
    try {
      for (const dir of readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort()) psqlOk(superuser, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      const org = randomUUID(), tenant = randomUUID(), subject = randomUUID(), connection = randomUUID();
      psqlOk(superuser, ["-1", "-c", `SET LOCAL session_replication_role = replica;
        INSERT INTO "Organization" ("id", "name", "slug", "status", "updatedAt") VALUES ('${org}', 'R7 owner', 'r7-owner-${suffix}', 'CLOSED', now());
        INSERT INTO "Tenant" ("id", "organizationId", "name", "updatedAt") VALUES ('${tenant}', '${org}', 'Production', now());
        INSERT INTO "ProviderConnection" ("id", "organizationId", "providerType", "externalScopeId", "name", "updatedAt") VALUES ('${connection}', '${org}', 'LUXIA_LOCAL', 'r7-owner', 'Local', now());
        INSERT INTO "Subject" ("id", "organizationId", "tenantId", "type", "name", "updatedAt") VALUES ('${subject}', '${org}', '${tenant}', 'HUMAN', 'Person', now());
        INSERT INTO "CanonicalAdminAuditEvent" ("id", "organizationId", "tenantId", "actorSubjectId", "operation", "changeId", "result") VALUES ('${randomUUID()}', '${org}', '${tenant}', '${subject}', 'SESSION.SIGN_OUT', 'r7-owner', 'SUCCESS');`]);
      // Everything LUXIA owns moves to the role: tables and sequences, functions, types, the schema.
      psqlOk(superuser, ["-1", "-c", `DO $o$ DECLARE r RECORD; BEGIN
        FOR r IN SELECT c.oid::regclass::text AS n, c.relkind FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relkind IN ('r', 'p') LOOP
          EXECUTE format('ALTER TABLE %s OWNER TO ${role}', r.n); END LOOP;
        FOR r IN SELECT c.oid::regclass::text AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relkind = 'S'
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')) LOOP
          EXECUTE format('ALTER SEQUENCE %s OWNER TO ${role}', r.n); END LOOP;
        FOR r IN SELECT p.oid::regprocedure::text AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' LOOP
          EXECUTE format('ALTER FUNCTION %s OWNER TO ${role}', r.n); END LOOP;
        FOR r IN SELECT t.oid::regtype::text AS n FROM pg_type t JOIN pg_namespace s ON s.oid = t.typnamespace WHERE s.nspname = 'public' AND t.typtype = 'e' LOOP
          EXECUTE format('ALTER TYPE %s OWNER TO ${role}', r.n); END LOOP;
        ALTER SCHEMA public OWNER TO ${role};
      END $o$`]);
      const [me] = await client.$queryRaw<Array<{ super: boolean; bypass: boolean; session: string }>>`SELECT r.rolsuper AS super, r.rolbypassrls AS bypass, session_user::text AS session FROM pg_roles r WHERE r.rolname = current_user`;
      expect(me).toEqual({ super: false, bypass: true, session: role });
      const ownerTarget = { host: "localhost", database: name, role };
      const { plan } = await planErasure(client, `r7-owner-${suffix}`, ownerTarget, TOOL);
      expect(plan.counts).toMatchObject({ CanonicalAdminAuditEvent: 1, Subject: 1, ProviderConnection: 1, Tenant: 1, Organization: 1 });
      // Control: the same role without BYPASSRLS is refused and nothing goes.
      psqlOk(superuser, ["-c", `ALTER ROLE ${role} NOBYPASSRLS`]);
      await client.$disconnect();
      expect(await codeOf(client.$queryRaw`SELECT luxia_organization_erase(${org})`)).toBe("ERASURE_REQUIRES_BYPASSRLS");
      expect(psqlOk(superuser, ["-c", `SELECT count(*) FROM "CanonicalAdminAuditEvent" WHERE "organizationId" = '${org}'`]).trim()).toBe("1");
      psqlOk(superuser, ["-c", `ALTER ROLE ${role} BYPASSRLS`]);
      await client.$disconnect();
      expect((await applyErasure(client, plan)).counts).toEqual(plan.counts);
      expect(psqlOk(superuser, ["-c", `SELECT count(*) FROM "CanonicalAdminAuditEvent"`, "-c", `SELECT count(*) FROM "Organization"`]).replace(/\r/g, "").trim().split("\n")).toEqual(["0", "0"]);
    } finally {
      await client.$disconnect();
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
      psql(admin, ["-c", `DROP ROLE IF EXISTS ${role}`]);
    }
  }, 240_000);

  it("drill: the migration applies on a scratch database; the rollback restores the catalog, and refuses once an erasure is recorded", () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_r7_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const catalog = () => psqlOk(url, ["-c", `SELECT string_agg(c.relname::text || ':' || c.relkind::text, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`,
      "-c", `SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`,
      "-c", `SELECT string_agg(tgname || ':' || md5(pg_get_triggerdef(oid)), ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal`]).replace(/\r/g, "");
    try {
      const prior = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
      for (const dir of prior) psqlOk(url, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      const before = catalog();
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(catalog()).toBe(before);
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      psqlOk(url, ["-c", `INSERT INTO "OrganizationErasure" ("organizationId", "counts") VALUES ('gone', '{}')`]);
      const refused = psql(url, ["-1", "-f", ROLLBACK]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/ROLLBACK_REFUSED_ERASURE_RECORDED/);
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 240_000);
});
