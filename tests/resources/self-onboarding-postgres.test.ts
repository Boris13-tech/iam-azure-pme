import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";

// Customer Self-Onboarding v1, step 1: migration, forced RLS, guards and definer functions on real
// PostgreSQL. app_user (rawPrisma, NOSUPERUSER NOBYPASSRLS) is the runtime; owner is the owner.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261011000000_customer_self_onboarding_v1";
const LEGRAND = "4841428a-80b4-4f07-bb3f-c94612dfd4a2";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const suffix = randomUUID().slice(0, 8);
// Table owner (migration role): fixtures and owner-side assertions. Created lazily: CI only.
let owner: PrismaClient;

function psql(url: string, args: string[]) {
  const target = new URL(url); target.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8" });
}
function psqlOk(url: string, args: string[]) {
  const result = psql(url, args);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout;
}

type Org = { organizationId: string; tenantId: string; admin: string; member: string };
async function organization(name: string): Promise<Org> {
  const org: Org = { organizationId: randomUUID(), tenantId: randomUUID(), admin: randomUUID(), member: randomUUID() };
  await owner.organization.create({ data: { id: org.organizationId, name, slug: `${name.toLowerCase()}-${suffix}` } });
  await owner.tenant.create({ data: { id: org.tenantId, organizationId: org.organizationId, name: "Production" } });
  for (const id of [org.admin, org.member])
    await owner.subject.create({ data: { id, organizationId: org.organizationId, tenantId: org.tenantId, type: "HUMAN", name: `${name} person` } });
  return org;
}
async function issueCode(code: string, data: { createdAt?: Date; expiresAt?: Date } = {}) {
  await owner.signupCode.create({ data: { codeHash: sha(code), issuedBy: "ci", expiresAt: data.expiresAt ?? new Date(Date.now() + 86_400_000), ...(data.createdAt ? { createdAt: data.createdAt } : {}) } });
}
const reserve = (codeHash: string, challengeHash: string, payload: unknown, ttl = 300) =>
  rawPrisma.$queryRaw<[{ ok: boolean }]>`SELECT luxia_signup_reserve(${codeHash}, ${challengeHash}, ${JSON.stringify(payload)}::jsonb, ${ttl}) AS ok`.then(rows => rows[0].ok);
const consume = (codeHash: string, challengeHash: string) =>
  rawPrisma.$queryRaw<Array<{ signup_code_id: string; organization_id: string; payload: Record<string, string> }>>`SELECT * FROM luxia_signup_consume(${codeHash}, ${challengeHash})`;
const resolveInvitation = (tokenHash: string) =>
  rawPrisma.$queryRaw<Array<{ invitation_id: string; organization_id: string; tenant_id: string; subject_id: string; invitation_role: string }>>`SELECT * FROM luxia_invitation_resolve(${tokenHash})`;
const invite = (org: Org, id: string, tokenHash: string, role: "MEMBER" | "ADMIN" = "MEMBER") => withTenantDb(org, tx => tx.$executeRaw`
  INSERT INTO "Invitation" ("id","organizationId","tenantId","subjectId","tokenHash","role","invitedBySubjectId","createdAt","expiresAt","updatedAt")
  VALUES (${id}, ${org.organizationId}, ${org.tenantId}, ${org.member}, ${tokenHash}, ${role}::"InvitationRole", ${org.admin}, '2020-01-01', '2099-01-01', now())`);

describe.runIf(enabled)("Customer Self-Onboarding v1: migration, RLS and adversarial PostgreSQL certification", () => {
  let a: Org, b: Org;
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    a = await organization("Alpha"); b = await organization("Beta");
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("requirement 12: the explicit legrand-tech backfill changes no existing data (scratch database, all prior migrations)", () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_backfill_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    try {
      const prior = readdirSync("prisma/migrations").filter(dir => /^\d{14}_/.test(dir) && dir < NEW).sort();
      expect(prior.length).toBeGreaterThanOrEqual(19);
      for (const dir of prior) psqlOk(scratch.toString(), ["-f", `prisma/migrations/${dir}/migration.sql`]);
      psqlOk(scratch.toString(), ["-f", "tests/resources/fixtures/self-onboarding-backfill-seed.sql"]);
      const before = psqlOk(scratch.toString(), ["-f", "scripts/certification/self-onboarding-business-digest.sql"]);
      psqlOk(scratch.toString(), ["-f", `prisma/migrations/${NEW}/migration.sql`]);
      const after = psqlOk(scratch.toString(), ["-f", "scripts/certification/self-onboarding-business-digest.sql"]);
      expect(before.trim().split("\n").length).toBeGreaterThanOrEqual(40);
      expect(before).toMatch(/^Organization\|2\|/m);
      expect(before).toMatch(/^IdentityAccount\|1\|/m);
      expect(after).toBe(before);
      const slugs = psqlOk(scratch.toString(), ["-c", `SELECT id || '=' || slug FROM "Organization" ORDER BY name`]).trim().split("\n");
      expect(slugs[0]).toBe(`${LEGRAND}=legrand-tech`);
      expect(slugs[1]).toMatch(/^0b9d0b8e-1111-4c2a-9a55-000000000001=org-[0-9a-f]{16}$/);
      const blocked = psql(scratch.toString(), ["-c", `UPDATE "Organization" SET slug='other' WHERE id='${LEGRAND}'`]);
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("ORGANIZATION_SLUG_IMMUTABLE");
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 300_000);

  it("requirement 13: forced RLS on the five tables; internal tables have no policy and no app_user privilege", async () => {
    const rows = await owner.$queryRaw<Array<{ relname: string; rls: boolean; force: boolean; policies: number; sel: boolean; ins: boolean; upd: boolean; del: boolean }>>`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS policies,
        has_table_privilege('app_user', c.oid, 'SELECT') AS sel, has_table_privilege('app_user', c.oid, 'INSERT') AS ins,
        has_table_privilege('app_user', c.oid, 'UPDATE') AS upd, has_table_privilege('app_user', c.oid, 'DELETE') AS del
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('SignupCode','OrganizationDomain','Invitation','RateLimitBucket','RateLimitConfig') ORDER BY c.relname`;
    expect(rows.map(row => row.relname)).toEqual(["Invitation", "OrganizationDomain", "RateLimitBucket", "RateLimitConfig", "SignupCode"]);
    for (const row of rows) {
      expect(row.rls && row.force, row.relname).toBe(true);
      const tenantTable = row.relname === "Invitation" || row.relname === "OrganizationDomain";
      expect(row.policies, row.relname).toBe(tenantTable ? 1 : 0);
      expect([row.sel, row.ins, row.upd], row.relname).toEqual(tenantTable ? [true, true, true] : [false, false, false]);
      expect(row.del, row.relname).toBe(false);
    }
    await expect(rawPrisma.$queryRaw`SELECT count(*) FROM "SignupCode"`).rejects.toThrow(/permission denied/);
    await expect(rawPrisma.$queryRaw`SELECT pepper FROM "RateLimitConfig"`).rejects.toThrow(/permission denied/);
    await expect(rawPrisma.$queryRaw`SELECT count(*) FROM "RateLimitBucket"`).rejects.toThrow(/permission denied/);
    const role = await rawPrisma.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("requirement 3: rate limiting counts per scope and client hash, refuses raw client data, stores no client value", async () => {
    const client = sha(`198.51.100.${suffix}`);
    const hit = (scope: string) => rawPrisma.$queryRaw<[{ ok: boolean }]>`SELECT luxia_rate_limit_hit(${scope}, ${client}, 86400, 3) AS ok`.then(rows => rows[0].ok);
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await hit("login-begin"));
    expect(results).toEqual([true, true, true, false]);
    expect(await hit("signup")).toBe(true);
    await expect(rawPrisma.$queryRaw`SELECT luxia_rate_limit_hit('login-begin', ${"198.51.100.7"}, 60, 3)`).rejects.toThrow(/RATE_LIMIT_INVALID_ARGUMENT/);
    const stored = await owner.rateLimitBucket.findMany({ where: { OR: [{ keyHash: client }, { keyHash: sha(`login-begin:${client}`) }] } });
    expect(stored).toHaveLength(0);
  });

  it("requirements 1, 5, 6: beta code is hashed, reserved, consumed once inside the founder transaction, never replayed", async () => {
    const code = `LUXIA-${randomUUID()}`, codeHash = sha(code);
    await issueCode(code);
    await expect(owner.signupCode.create({ data: { codeHash: code, issuedBy: "ci", expiresAt: new Date(Date.now() + 3_600_000) } })).rejects.toThrow(/SignupCode_hashes/);
    const payload = { organizationName: "Gamma SAS", slug: `gamma-${suffix}`, founderName: "Founder Gamma", principalName: "founder" };
    expect(await reserve(sha("unknown"), sha("c1"), payload)).toBe(false);
    expect(await reserve(codeHash, sha("c1"), { ...payload, role: "ADMIN" })).toBe(false);
    expect(await reserve(codeHash, sha("c1"), { ...payload, slug: "Not A Slug" })).toBe(false);
    expect(await reserve(codeHash, sha("c1"), payload)).toBe(true);
    expect(await reserve(codeHash, sha("c2"), payload)).toBe(true);
    expect(await consume(codeHash, sha("c1"))).toEqual([]);

    // Founder transaction fails after consumption: nothing remains, the code is still usable.
    await expect(rawPrisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ organization_id: string }>>`SELECT * FROM luxia_signup_consume(${codeHash}, ${sha("c2")})`;
      expect(rows).toHaveLength(1);
      throw new Error("FOUNDER_STEP_FAILED");
    })).rejects.toThrow("FOUNDER_STEP_FAILED");
    expect(await owner.organization.count({ where: { slug: payload.slug } })).toBe(0);
    expect((await owner.signupCode.findUniqueOrThrow({ where: { codeHash } })).status).toBe("RESERVED");

    const [created] = await consume(codeHash, sha("c2"));
    expect(created.payload).toEqual(payload);
    const org = await owner.organization.findUniqueOrThrow({ where: { id: created.organization_id } });
    expect({ name: org.name, slug: org.slug }).toEqual({ name: "Gamma SAS", slug: payload.slug });
    const row = await owner.signupCode.findUniqueOrThrow({ where: { codeHash } });
    expect(row).toMatchObject({ status: "CONSUMED", organizationId: org.id, pendingPayload: null, pendingChallengeHash: null });
    expect(await consume(codeHash, sha("c2"))).toEqual([]);
    expect(await reserve(codeHash, sha("c3"), { ...payload, slug: `gamma2-${suffix}` })).toBe(false);
    await expect(owner.$executeRaw`UPDATE "SignupCode" SET "status"='ISSUED', "consumedAt"=NULL, "organizationId"=NULL WHERE "codeHash"=${codeHash}`).rejects.toThrow(/SIGNUP_CODE_IMMUTABLE/);
    await expect(owner.$executeRaw`DELETE FROM "SignupCode" WHERE "codeHash"=${codeHash}`).rejects.toThrow(/SIGNUP_CODE_IMMUTABLE/);

    // A taken slug aborts the whole transaction: no organization, code not consumed.
    const code2 = `LUXIA-${randomUUID()}`;
    await issueCode(code2);
    expect(await reserve(sha(code2), sha("d1"), { ...payload, organizationName: "Copycat" })).toBe(true);
    await expect(consume(sha(code2), sha("d1"))).rejects.toThrow(/Organization_slug_key|unique/i);
    expect((await owner.signupCode.findUniqueOrThrow({ where: { codeHash: sha(code2) } })).status).toBe("RESERVED");
    expect(await owner.organization.count({ where: { name: "Copycat" } })).toBe(0);
  });

  it("expired, revoked and stale reservations are refused", async () => {
    const payload = { organizationName: "Delta SAS", slug: `delta-${suffix}`, founderName: "Founder Delta", principalName: "founder" };
    const expired = `LUXIA-${randomUUID()}`;
    await issueCode(expired, { createdAt: new Date(Date.now() - 2 * 86_400_000), expiresAt: new Date(Date.now() - 86_400_000) });
    expect(await reserve(sha(expired), sha("e1"), payload)).toBe(false);
    expect((await owner.signupCode.findUniqueOrThrow({ where: { codeHash: sha(expired) } })).status).toBe("EXPIRED");
    const revoked = `LUXIA-${randomUUID()}`;
    await issueCode(revoked);
    await owner.signupCode.update({ where: { codeHash: sha(revoked) }, data: { status: "REVOKED", revokedAt: new Date(), revokedBy: "ci" } });
    expect(await reserve(sha(revoked), sha("r1"), payload)).toBe(false);
    const stale = `LUXIA-${randomUUID()}`;
    await issueCode(stale);
    expect(await reserve(sha(stale), sha("s1"), payload)).toBe(true);
    await owner.signupCode.update({ where: { codeHash: sha(stale) }, data: { pendingExpiresAt: new Date(Date.now() - 1000) } });
    expect(await consume(sha(stale), sha("s1"))).toEqual([]);
    expect(await owner.organization.count({ where: { slug: payload.slug } })).toBe(0);
  });

  it("Org A and Org B cannot see or change each other's invitations and domains", async () => {
    await invite(a, `inv-a-${suffix}`, sha(`token-a-${suffix}`));
    await withTenantDb(a, tx => tx.$executeRaw`INSERT INTO "OrganizationDomain" ("id","organizationId","tenantId","domain","challengeHash","challengeExpiresAt","updatedAt")
      VALUES (${`dom-a-${suffix}`}, ${a.organizationId}, ${a.tenantId}, ${`alpha-${suffix}.example`}, ${sha("challenge-a")}, now() + interval '7 days', now())`);
    await invite(b, `inv-b-${suffix}`, sha(`token-b-${suffix}`));
    for (const [viewer, other] of [[b, a], [a, b]] as const) {
      const seen = await withTenantDb(viewer, async tx => ({
        invitations: await tx.invitation.findMany({ where: { organizationId: other.organizationId } }),
        domains: await tx.organizationDomain.findMany({ where: { organizationId: other.organizationId } }),
        revoked: await tx.$executeRaw`UPDATE "Invitation" SET "revokedAt"=now() WHERE "organizationId"=${other.organizationId}`,
      }));
      expect(seen).toEqual({ invitations: [], domains: [], revoked: 0 });
      await expect(withTenantDb(viewer, tx => tx.$executeRaw`INSERT INTO "Invitation" ("id","organizationId","tenantId","subjectId","tokenHash","role","invitedBySubjectId","updatedAt")
        VALUES (${randomUUID()}, ${other.organizationId}, ${other.tenantId}, ${other.admin}, ${sha(randomUUID())}, 'ADMIN', ${other.admin}, now())`)).rejects.toThrow(/row-level security/);
    }
    const noContext = await rawPrisma.$queryRaw<[{ n: number }]>`SELECT ((SELECT count(*) FROM "Invitation") + (SELECT count(*) FROM "OrganizationDomain"))::int AS n`;
    expect(noContext[0].n).toBe(0);
  });

  it("requirements 8, 9: invitation expiry is set by the database; tenant, person and role never change; accepted once", async () => {
    const tokenHash = sha(`token-c-${suffix}`), id = `inv-c-${suffix}`;
    const c = await organization("Charlie");
    await invite(c, id, tokenHash);
    const row = await withTenantDb(c, tx => tx.invitation.findUniqueOrThrow({ where: { id } }));
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(7 * 86_400_000);
    expect(row.createdAt.getTime()).toBeGreaterThan(Date.now() - 600_000);
    await expect(invite(c, `inv-c2-${suffix}`, sha(`token-c2-${suffix}`))).rejects.toThrow(/Invitation_one_open_per_subject|Unique/i);
    for (const change of [
      withTenantDb(c, tx => tx.$executeRaw`UPDATE "Invitation" SET "role"='ADMIN' WHERE "id"=${id}`),
      withTenantDb(c, tx => tx.$executeRaw`UPDATE "Invitation" SET "subjectId"=${c.admin} WHERE "id"=${id}`),
      withTenantDb(c, tx => tx.$executeRaw`UPDATE "Invitation" SET "expiresAt"="expiresAt" + interval '30 days' WHERE "id"=${id}`),
      owner.$executeRaw`DELETE FROM "Invitation" WHERE "id"=${id}`,
    ]) await expect(change).rejects.toThrow(/INVITATION_IMMUTABLE/);
    await expect(withTenantDb(c, tx => tx.$executeRaw`DELETE FROM "Invitation" WHERE "id"=${id}`)).rejects.toThrow(/permission denied/);

    expect(await resolveInvitation(tokenHash)).toEqual([{ invitation_id: id, organization_id: c.organizationId, tenant_id: c.tenantId, subject_id: c.member, invitation_role: "MEMBER" }]);
    expect(await resolveInvitation(sha("unknown"))).toEqual([]);
    expect(await resolveInvitation(`token-c-${suffix}`)).toEqual([]);
    expect(await withTenantDb(c, tx => tx.$executeRaw`UPDATE "Invitation" SET "acceptedAt"=now() WHERE "id"=${id} AND "acceptedAt" IS NULL`)).toBe(1);
    await expect(withTenantDb(c, tx => tx.$executeRaw`UPDATE "Invitation" SET "acceptedAt"=now() WHERE "id"=${id}`)).rejects.toThrow(/INVITATION_IMMUTABLE/);
    expect(await resolveInvitation(tokenHash)).toEqual([]);

    // An expired invitation can neither be resolved nor accepted (fixture rewound with triggers off).
    const expiredId = `inv-e-${suffix}`, expiredHash = sha(`token-e-${suffix}`);
    const d = await organization("Echo");
    await invite(d, expiredId, expiredHash, "ADMIN");
    await owner.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`UPDATE "Invitation" SET "createdAt"=now() - interval '8 days', "expiresAt"=now() - interval '1 day' WHERE "id"=${expiredId}`;
    });
    expect(await resolveInvitation(expiredHash)).toEqual([]);
    await expect(withTenantDb(d, tx => tx.$executeRaw`UPDATE "Invitation" SET "acceptedAt"=now() WHERE "id"=${expiredId}`)).rejects.toThrow(/INVITATION_EXPIRED/);
  });

  it("requirements 10, 11: a domain is verified by one organization only, is normalized and never renamed", async () => {
    const domain = `shared-${suffix}.example`;
    for (const [org, id] of [[a, `dom-a2-${suffix}`], [b, `dom-b2-${suffix}`]] as const)
      await withTenantDb(org, tx => tx.$executeRaw`INSERT INTO "OrganizationDomain" ("id","organizationId","tenantId","domain","challengeHash","challengeExpiresAt","updatedAt")
        VALUES (${id}, ${org.organizationId}, ${org.tenantId}, ${domain}, ${sha(id)}, now() + interval '7 days', now())`);
    expect(await withTenantDb(a, tx => tx.$executeRaw`UPDATE "OrganizationDomain" SET "status"='VERIFIED', "verifiedAt"=now() WHERE "id"=${`dom-a2-${suffix}`}`)).toBe(1);
    await expect(withTenantDb(b, tx => tx.$executeRaw`UPDATE "OrganizationDomain" SET "status"='VERIFIED', "verifiedAt"=now() WHERE "id"=${`dom-b2-${suffix}`}`)).rejects.toThrow(/OrganizationDomain_verified_domain_key|unique/i);
    await expect(withTenantDb(a, tx => tx.$executeRaw`UPDATE "OrganizationDomain" SET "domain"='other.example' WHERE "id"=${`dom-a2-${suffix}`}`)).rejects.toThrow(/ORGANIZATION_DOMAIN_IMMUTABLE/);
    await expect(withTenantDb(a, tx => tx.$executeRaw`UPDATE "OrganizationDomain" SET "status"='VERIFIED', "verifiedAt"=NULL WHERE "id"=${`dom-a-${suffix}`}`)).rejects.toThrow(/OrganizationDomain_state/);
    await expect(withTenantDb(a, tx => tx.$executeRaw`INSERT INTO "OrganizationDomain" ("id","organizationId","tenantId","domain","challengeHash","challengeExpiresAt","updatedAt")
      VALUES (${randomUUID()}, ${a.organizationId}, ${a.tenantId}, ${"Upper.EXAMPLE"}, ${sha("u")}, now() + interval '7 days', now())`)).rejects.toThrow(/OrganizationDomain_domain_format/);
    // Releasing the domain (LOST) lets another organization verify it.
    await withTenantDb(a, tx => tx.$executeRaw`UPDATE "OrganizationDomain" SET "status"='LOST' WHERE "id"=${`dom-a2-${suffix}`}`);
    expect(await withTenantDb(b, tx => tx.$executeRaw`UPDATE "OrganizationDomain" SET "status"='VERIFIED', "verifiedAt"=now() WHERE "id"=${`dom-b2-${suffix}`}`)).toBe(1);
  });

  it("requirement 4: the slug is normalized and immutable for everyone, other organization fields stay editable", async () => {
    await expect(owner.$executeRaw`UPDATE "Organization" SET "slug"=${`renamed-${suffix}`} WHERE "id"=${a.organizationId}`).rejects.toThrow(/ORGANIZATION_SLUG_IMMUTABLE/);
    await expect(rawPrisma.$executeRaw`UPDATE "Organization" SET "slug"=${`renamed-${suffix}`} WHERE "id"=${a.organizationId}`).rejects.toThrow(/ORGANIZATION_SLUG_IMMUTABLE/);
    await expect(owner.organization.create({ data: { name: "Bad", slug: "Has Space" } })).rejects.toThrow(/Organization_slug_format/);
    await expect(owner.organization.create({ data: { name: "Bad", slug: "double--dash" } })).rejects.toThrow(/Organization_slug_format/);
    expect((await owner.organization.create({ data: { name: "Default slug" } })).slug).toMatch(/^org-[0-9a-f]{16}$/);
    expect(await owner.organization.update({ where: { id: a.organizationId }, data: { name: "Alpha renamed" } })).toMatchObject({ slug: `alpha-${suffix}` });
  });
});
