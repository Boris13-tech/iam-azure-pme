// R7 (docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md): erasure of a CLOSED organization by the operator
// procedure, on PostgreSQL with the real guards. Every row of the erased organization goes; every other
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
  await owner.assignment.create({ data: { ...scope, subjectId: subject.id, entitlementId: entitlement.id, source: "DIRECT", sourceRef: "r7-test" } });
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
      CanonicalAdminAuditEvent: journal, ProviderConnection: 1, Tenant: 1 });
    const result = await applyErasure(owner, plan);
    expect(result.counts).toEqual(plan.counts);
    const left = await remaining(a.organizationId);
    expect(left.tables).toBeGreaterThanOrEqual(ERASURE_TABLES.length);
    expect(left.rows).toBe(0);
    expect(await owner.organizationErasure.findUniqueOrThrow({ where: { organizationId: a.organizationId } })).toMatchObject({ counts: plan.counts });
    expect(await fingerprint(b.organizationId)).toEqual(before);
    // The marker does not outlive the erasure.
    expect(await codeOf(owner.$executeRawUnsafe(`DELETE FROM "CanonicalAdminAuditEvent" WHERE "organizationId" = $1`, b.organizationId))).toBe("AUDIT_APPEND_ONLY");
  }, 120_000);

  it("a plan made stale by any new row is refused, and nothing is deleted", async () => {
    const c = await organization();
    await close(c);
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
