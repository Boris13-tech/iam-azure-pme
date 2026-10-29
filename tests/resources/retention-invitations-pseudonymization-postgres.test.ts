// R4 and R6 (docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md), on PostgreSQL with the real guards and roles.
// R4: the daily job deletes invitations finished (accepted, revoked or expired) and created more than 30 days ago.
// R6: it pseudonymizes the name and the local sign-in name of a person RETIRED for more than 30 days; the journal
// and the sign-in evidence stay byte-identical. Both run as app_user through definer entry points, counts only.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { SessionStore } from "../../lib/auth/session-store";
import { entraSignInEvidence } from "../../lib/auth/sign-in-evidence";
import { softwarePasskey } from "../helpers/software-passkey";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261025120000_retention_invitations_pseudonymization";
const ROLLBACK = "docs/operations/RETENTION-INVITATIONS-PSEUDONYMIZATION-ROLLBACK.sql";
const suffix = randomUUID().slice(0, 8);
const DAY = 86_400_000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let owner: PrismaClient;
let orgs = 0;

type Counts = Record<string, number | boolean>;
const call = (fn: "luxia_retention_purge_invitations" | "luxia_retention_pseudonymize_retired", batch: number | null, enforce: boolean | null, db: PrismaClient = rawPrisma) =>
  db.$queryRawUnsafe<Array<{ counts: Counts }>>(`SELECT ${fn}(${batch}, ${enforce}) AS counts`).then((rows) => rows[0].counts);
const settle = (promise: Promise<unknown>) => promise.then(() => "ACCEPTED", (error: unknown) => String(error instanceof Error ? error.message : error));
/** Runs enforced calls until one selects nothing: the shared test database may hold rows of earlier runs. */
async function drain(fn: "luxia_retention_purge_invitations" | "luxia_retention_pseudonymize_retired", key: string) {
  for (let i = 0; i < 20; i++) if ((await call(fn, 5000, true))[key] === 0) return;
  throw new Error("DRAIN_DID_NOT_CONVERGE");
}

type Org = { organizationId: string; tenantId: string; local: string; entra: string; admin: string };
async function organization(): Promise<Org> {
  const organizationId = randomUUID(), tenantId = randomUUID();
  await owner.organization.create({ data: { id: organizationId, name: "R4 R6 retention", slug: `r4r6-${suffix}-${++orgs}` } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const connect = async (providerType: "LUXIA_LOCAL" | "MICROSOFT_ENTRA") => {
    const connection = await owner.providerConnection.create({ data: { organizationId, providerType, externalScopeId: `${providerType}-${organizationId}`, name: providerType } });
    await owner.providerConnectionTenantScope.create({ data: { organizationId, tenantId, providerConnectionId: connection.id } });
    return connection.id;
  };
  const local = await connect("LUXIA_LOCAL"), entra = await connect("MICROSOFT_ENTRA");
  const admin = await owner.subject.create({ data: { organizationId, tenantId, type: "HUMAN", name: "Admin", lifecycleState: "ACTIVE" } });
  return { organizationId, tenantId, local, entra, admin: admin.id };
}
const scope = (org: Org) => ({ organizationId: org.organizationId, tenantId: org.tenantId });

/** Every row of an organization in the tables R4 and R6 touch, as one digest per table. */
async function fingerprint(organizationId: string) {
  const out: Record<string, string> = {};
  for (const table of ["Subject", "IdentityAccount", "LocalIdentity", "LocalAuthenticator", "Invitation", "Session", "CanonicalAdminAuditEvent", "AuthenticationEvidence"]) {
    const [row] = await owner.$queryRawUnsafe<Array<{ digest: string | null; n: number }>>(
      `SELECT md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)) AS digest, count(*)::int AS n FROM "${table}" t WHERE "organizationId" = $1`, organizationId);
    out[table] = `${row.n}:${row.digest ?? "-"}`;
  }
  return out;
}
/** A whole table, every organization, as one digest. */
async function tableDigest(table: string) {
  const [row] = await owner.$queryRawUnsafe<Array<{ digest: string | null; n: number }>>(
    `SELECT md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)) AS digest, count(*)::int AS n FROM "${table}" t`);
  return `${row.n}:${row.digest ?? "-"}`;
}
const json = async (table: string, id: string) => (await owner.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "id" = $1`, id))[0]?.row;

function psql(url: string, args: string[]) {
  const target = new URL(url); target.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8" });
}
function psqlOk(url: string, args: string[]) {
  const result = psql(url, args);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr ?? result.error}`);
  return result.stdout;
}

describe.runIf(enabled)("R4: purge of finished invitations (PostgreSQL)", () => {
  let a: Org, b: Org;
  /** An invitation, then its dates set in days ago (negative: in the future), skipping the guard as a superuser would. */
  async function invitation(org: Org, days: { created: number; expires: number; accepted?: number; revoked?: number } | null) {
    const invitee = await owner.subject.create({ data: { ...scope(org), type: "HUMAN", name: "Invitee", lifecycleState: "PROVISIONING" } });
    const row = await owner.invitation.create({ data: { ...scope(org), subjectId: invitee.id, tokenHash: sha(randomUUID()), role: "MEMBER", invitedBySubjectId: org.admin } });
    if (days) await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRawUnsafe(`UPDATE "Invitation" SET
          "createdAt" = (now() AT TIME ZONE 'UTC') - $2::float8 * interval '1 day',
          "expiresAt" = (now() AT TIME ZONE 'UTC') - $3::float8 * interval '1 day',
          "acceptedAt" = (now() AT TIME ZONE 'UTC') - $4::float8 * interval '1 day',
          "revokedAt" = (now() AT TIME ZONE 'UTC') - $5::float8 * interval '1 day'
        WHERE "id" = $1`, row.id, days.created, days.expires, days.accepted ?? null, days.revoked ?? null);
    });
    return row.id;
  }
  const present = async (ids: string[]) => (await owner.invitation.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id).sort();

  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    a = await organization();
    b = await organization();
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("the runtime role runs it: the dry run changes nothing, then only rows past the period go, other organizations untouched", async () => {
    const gone = [
      await invitation(a, { created: 32, expires: 25, accepted: 31 }),
      await invitation(a, { created: 33, expires: 26, revoked: 31 }),
      await invitation(a, { created: 38, expires: 31 }),
    ];
    const kept = [
      await invitation(a, { created: 29.5, expires: 22.5, accepted: 29 }), // accepted 29 days ago
      await invitation(a, { created: 36, expires: 29 }), // expired 29 days ago
      await invitation(a, null), // pending
      await invitation(a, { created: 1, expires: -6, revoked: 60 }), // a backdated revocation on a row created yesterday
    ];
    await invitation(b, { created: 11, expires: 4, revoked: 10 });
    await invitation(b, { created: 36, expires: 29 });
    const otherOrg = await fingerprint(b.organizationId);

    const before = await tableDigest("Invitation");
    const dry = await call("luxia_retention_purge_invitations", 5000, false);
    expect(dry.enforced).toBe(false);
    expect(dry.invitations).toBeGreaterThanOrEqual(3);
    expect(await tableDigest("Invitation")).toBe(before);

    const run = await call("luxia_retention_purge_invitations", 5000, true);
    expect(run).toMatchObject({ enforced: true });
    expect(run.invitations).toBeGreaterThanOrEqual(3);
    await drain("luxia_retention_purge_invitations", "invitations");
    expect(await present([...gone, ...kept])).toEqual([...kept].sort());
    expect(await fingerprint(b.organizationId)).toEqual(otherOrg);
    expect(await call("luxia_retention_purge_invitations", 5000, true)).toEqual({ invitations: 0, enforced: true });
  });

  it("each call is bounded by its batch, and arguments out of range are refused", async () => {
    await drain("luxia_retention_purge_invitations", "invitations");
    const old = [await invitation(a, { created: 40, expires: 33 }), await invitation(a, { created: 41, expires: 34 }), await invitation(a, { created: 42, expires: 35 })];
    expect(await call("luxia_retention_purge_invitations", 1, false)).toEqual({ invitations: 1, enforced: false });
    expect(await call("luxia_retention_purge_invitations", 1, true)).toEqual({ invitations: 1, enforced: true });
    expect(await present(old)).toHaveLength(2);
    expect(await call("luxia_retention_purge_invitations", 5000, true)).toEqual({ invitations: 2, enforced: true });
    expect(await present(old)).toHaveLength(0);
    for (const [batch, enforce] of [[0, true], [5001, true], [-1, false], [null, true], [10, null]] as const)
      expect(await settle(call("luxia_retention_purge_invitations", batch, enforce))).toMatch(/RETENTION_ARGUMENT_OUT_OF_RANGE/);
  });

  it("the gate is data-based: the runtime still cannot delete; the owner can delete exactly a row past the period, nothing younger", async () => {
    const past = await invitation(a, { created: 45, expires: 38 });
    const young = await invitation(a, { created: 36, expires: 29 });
    const forged = await invitation(a, { created: 2, expires: -5, accepted: 90 });
    const pending = await invitation(a, null);
    // The runtime role has no DELETE privilege on Invitation, even for a row the gate would let through.
    expect(await settle(rawPrisma.$executeRawUnsafe(`DELETE FROM "Invitation" WHERE "id" = $1`, past))).toMatch(/permission denied/);
    for (const id of [young, forged, pending])
      expect(await settle(owner.$executeRawUnsafe(`DELETE FROM "Invitation" WHERE "id" = $1`, id)), id).toMatch(/INVITATION_IMMUTABLE/);
    // UPDATE and TRUNCATE are not let through by the gate.
    expect(await settle(owner.$executeRawUnsafe(`UPDATE "Invitation" SET "role" = 'ADMIN' WHERE "id" = $1`, past))).toMatch(/INVITATION_IMMUTABLE/);
    expect(await owner.$executeRawUnsafe(`DELETE FROM "Invitation" WHERE "id" = $1`, past)).toBe(1);
    expect(await present([past, young, forged, pending])).toEqual([young, forged, pending].sort());
  });

  it("one run at a time", async () => {
    const result = await owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('luxia-retention-purge-invitations', 0))::text`;
      return settle(call("luxia_retention_purge_invitations", 10, false));
    });
    expect(result).toMatch(/RETENTION_ALREADY_RUNNING/);
  });
});

describe.runIf(enabled)("R6: pseudonymization of people retired for more than 30 days (PostgreSQL)", () => {
  let a: Org, b: Org;
  type Person = { subjectId: string; localAccountId: string; localIdentityId: string; entraAccountId: string };
  async function person(org: Org, name: string, opts: { retiredDaysAgo?: number; type?: "HUMAN" | "SERVICE"; activeSinceDays?: number; signIn?: boolean } = {}): Promise<Person> {
    const subject = await owner.subject.create({ data: { ...scope(org), type: opts.type ?? "HUMAN", name, lifecycleState: "ACTIVE" } });
    const local = await owner.identityAccount.create({ data: { ...scope(org), subjectId: subject.id, providerConnectionId: org.local, externalObjectId: randomUUID() } });
    const entra = await owner.identityAccount.create({ data: { ...scope(org), subjectId: subject.id, providerConnectionId: org.entra, externalObjectId: randomUUID() } });
    const identity = await owner.localIdentity.create({ data: { ...scope(org), identityAccountId: local.id, principalName: `${name.toLowerCase().replace(/\W/g, "")}-${randomUUID().slice(0, 8)}` } });
    const key = softwarePasskey();
    await owner.localAuthenticator.create({ data: { ...scope(org), identityAccountId: local.id, type: "PASSKEY", credentialId: key.credentialId, publicKey: key.publicKeyPem,
      relyingPartyId: "localhost", allowedOrigin: "http://localhost:3000", credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY", algorithmId: "WEBAUTHN_ES256" } });
    if (opts.signIn) {
      // A session with its sign-in evidence, and a journal event naming the person by identifier: what R6 must not touch.
      await SessionStore.createSession({ ...scope(org), subjectId: subject.id, identityAccountId: entra.id }, undefined, undefined,
        { evidence: entraSignInEvidence({ ...scope(org), subjectId: subject.id, identityAccountId: entra.id, providerConnectionId: org.entra }, "VERIFIED", "R6_TEST") });
      await owner.canonicalAdminAuditEvent.create({ data: { ...scope(org), actorSubjectId: org.admin, targetSubjectId: subject.id, operation: "SUBJECT.UPDATE",
        changeId: `r6:${randomUUID()}`, result: "SUCCESS", metadata: { nameChanged: false, lifecycleFrom: "ACTIVE", lifecycleTo: "RETIRED" } } });
    }
    if (opts.retiredDaysAgo != null)
      await owner.subject.update({ where: { id: subject.id }, data: { lifecycleState: "RETIRED", lifecycleChangedAt: new Date(Date.now() - opts.retiredDaysAgo * DAY) } });
    if (opts.activeSinceDays != null)
      await owner.subject.update({ where: { id: subject.id }, data: { lifecycleChangedAt: new Date(Date.now() - opts.activeSinceDays * DAY) } });
    return { subjectId: subject.id, localAccountId: local.id, localIdentityId: identity.id, entraAccountId: entra.id };
  }
  /** The rows of one person in the tables R6 could reach. */
  const snapshot = async (p: Person) => ({
    subject: await json("Subject", p.subjectId), localIdentity: await json("LocalIdentity", p.localIdentityId),
    localAccount: await json("IdentityAccount", p.localAccountId), entraAccount: await json("IdentityAccount", p.entraAccountId),
    authenticators: await owner.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM "LocalAuthenticator" t WHERE "identityAccountId" = $1 ORDER BY "id"`, p.localAccountId),
  });

  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    a = await organization();
    b = await organization();
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("replaces exactly the name and the local sign-in name; the journal and the sign-in evidence are byte-identical", async () => {
    await drain("luxia_retention_pseudonymize_retired", "subjects");
    const gone = await person(a, "Jeanne Martin", { retiredDaysAgo: 31, signIn: true });
    const recent = await person(a, "Paul Recent", { retiredDaysAgo: 29, signIn: true });
    const active = await person(a, "Awa Active", { activeSinceDays: 60 });
    const service = await person(a, "Build Robot", { retiredDaysAgo: 40, type: "SERVICE" });
    await person(b, "Bravo Recent", { retiredDaysAgo: 29 });
    await person(b, "Bravo Active", { activeSinceDays: 90 });
    const otherOrg = await fingerprint(b.organizationId);
    const journal = { audit: await tableDigest("CanonicalAdminAuditEvent"), evidence: await tableDigest("AuthenticationEvidence"), sessions: await tableDigest("Session") };
    const before = { gone: await snapshot(gone), recent: await snapshot(recent), active: await snapshot(active), service: await snapshot(service) };
    const all = { subjects: await tableDigest("Subject"), identities: await tableDigest("LocalIdentity") };

    expect(await call("luxia_retention_pseudonymize_retired", 5000, false)).toEqual({ subjects: 1, displayNames: 1, principalNames: 1, enforced: false });
    expect({ subjects: await tableDigest("Subject"), identities: await tableDigest("LocalIdentity") }).toEqual(all);

    expect(await call("luxia_retention_pseudonymize_retired", 5000, true)).toEqual({ subjects: 1, displayNames: 1, principalNames: 1, enforced: true });
    const after = await snapshot(gone);
    expect(after.subject!.name).toBe(`Ancien membre ${sha(gone.subjectId).slice(0, 8)}`);
    expect(after.localIdentity!.principalName).toBe(`ANCIEN-MEMBRE-${sha(gone.localIdentityId)}`);
    // Every other column, and every other row of the person, is unchanged.
    expect({ ...after.subject, name: null }).toEqual({ ...before.gone.subject, name: null });
    expect({ ...after.localIdentity, principalName: null }).toEqual({ ...before.gone.localIdentity, principalName: null });
    expect({ ...after, subject: null, localIdentity: null }).toEqual({ ...before.gone, subject: null, localIdentity: null });
    for (const [label, p] of [["recent", recent], ["active", active], ["service", service]] as const)
      expect(await snapshot(p), label).toEqual(before[label]);
    expect(await fingerprint(b.organizationId)).toEqual(otherOrg);
    expect({ audit: await tableDigest("CanonicalAdminAuditEvent"), evidence: await tableDigest("AuthenticationEvidence"), sessions: await tableDigest("Session") }).toEqual(journal);

    // Idempotent: nothing left to do. A name set back by an administrator is pseudonymized again on the next run.
    expect(await call("luxia_retention_pseudonymize_retired", 5000, true)).toEqual({ subjects: 0, displayNames: 0, principalNames: 0, enforced: true });
    await owner.$executeRawUnsafe(`UPDATE "Subject" SET "name" = 'Jeanne Martin' WHERE "id" = $1`, gone.subjectId);
    expect(await call("luxia_retention_pseudonymize_retired", 5000, true)).toEqual({ subjects: 1, displayNames: 1, principalNames: 0, enforced: true });
    expect(await snapshot(gone)).toEqual(after);
    expect({ audit: await tableDigest("CanonicalAdminAuditEvent"), evidence: await tableDigest("AuthenticationEvidence") }).toEqual({ audit: journal.audit, evidence: journal.evidence });
  }, 120_000);

  it("each call is bounded by its batch, arguments out of range are refused, one run at a time", async () => {
    await drain("luxia_retention_pseudonymize_retired", "subjects");
    const people = [await person(a, "First Leaver", { retiredDaysAgo: 50 }), await person(a, "Second Leaver", { retiredDaysAgo: 45 })];
    expect(await call("luxia_retention_pseudonymize_retired", 1, true)).toEqual({ subjects: 1, displayNames: 1, principalNames: 1, enforced: true });
    // Oldest retirement first.
    expect((await json("Subject", people[0].subjectId))!.name).toBe(`Ancien membre ${sha(people[0].subjectId).slice(0, 8)}`);
    expect((await json("Subject", people[1].subjectId))!.name).toBe("Second Leaver");
    expect(await call("luxia_retention_pseudonymize_retired", 5000, true)).toEqual({ subjects: 1, displayNames: 1, principalNames: 1, enforced: true });
    for (const [batch, enforce] of [[0, true], [5001, true], [null, false], [10, null]] as const)
      expect(await settle(call("luxia_retention_pseudonymize_retired", batch, enforce))).toMatch(/RETENTION_ARGUMENT_OUT_OF_RANGE/);
    const result = await owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('luxia-retention-pseudonymize-retired', 0))::text`;
      return settle(call("luxia_retention_pseudonymize_retired", 10, false));
    });
    expect(result).toMatch(/RETENTION_ALREADY_RUNNING/);
  }, 120_000);

  it("the runtime role may execute the two entry points and nothing more; anonymous roles and PUBLIC may not", async () => {
    const rows = await owner.$queryRaw<Array<{ proname: string; runtime: boolean; public_execute: boolean; definer: boolean }>>`
      SELECT p.proname, has_function_privilege('app_user', p.oid, 'EXECUTE') AS runtime, p.prosecdef AS definer,
        EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('luxia_retention_purge_invitations', 'luxia_retention_pseudonymize_retired', 'luxia_invitation_guard')
      ORDER BY p.proname`;
    expect(rows).toEqual([
      { proname: "luxia_invitation_guard", runtime: false, definer: false, public_execute: false },
      { proname: "luxia_retention_pseudonymize_retired", runtime: true, definer: true, public_execute: false },
      { proname: "luxia_retention_purge_invitations", runtime: true, definer: true, public_execute: false },
    ]);
    const [privileges] = await owner.$queryRaw<Array<{ del: boolean; trunc: boolean }>>`
      SELECT has_table_privilege('app_user', '"Invitation"', 'DELETE') AS del, has_table_privilege('app_user', '"Invitation"', 'TRUNCATE') AS trunc`;
    expect(privileges).toEqual({ del: false, trunc: false });
  });

  it("drill: the migration applies on a scratch database, the rollback restores the catalog exactly, and it applies again", () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_r4r6_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const catalog = () => psqlOk(url, ["-c", `SELECT string_agg(c.relname::text || ':' || c.relkind::text, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`,
      "-c", `SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, '-'), ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`,
      "-c", `SELECT string_agg(tgname || ':' || md5(pg_get_triggerdef(oid)), ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal`]).replace(/\r/g, "");
    try {
      const prior = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
      for (const dir of prior) psqlOk(url, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      const before = catalog();
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(psqlOk(url, ["-c", `SELECT luxia_retention_purge_invitations(10, true)::text`, "-c", `SELECT luxia_retention_pseudonymize_retired(10, false)::text`]).trim().split("\n"))
        .toEqual(['{"enforced": true, "invitations": 0}', '{"enforced": false, "subjects": 0, "displayNames": 0, "principalNames": 0}']);
      expect(catalog()).not.toBe(before);
      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(catalog()).toBe(before);
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 240_000);
});
