import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { SessionStore } from "../../lib/auth/session-store";
import { grantAssignment } from "../../lib/admin/canonical-administration";
import { beginAcceptance, completeAcceptance } from "../../lib/onboarding/invitations";
import { softwarePasskey } from "../helpers/software-passkey";

// First Admin / Break-glass v1: Organization.status and Session.scope on PostgreSQL.
// Design: docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-MIGRATION-DESIGN.md (M1-M6, A1-A5).
// app_user (rawPrisma) is the runtime; owner (BYPASSRLS) plays the operator procedure that B4 will
// implement: governance locks first, status first, then effects, in one transaction.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261011180000_organization_status_session_scope";
const ROLLBACK = "docs/operations/ORGANIZATION-STATUS-SESSION-SCOPE-ROLLBACK.sql";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const suffix = randomUUID().slice(0, 8);
let owner: PrismaClient;
let orgs = 0;

type Status = "ACTIVE" | "SUSPENDED" | "CLOSED";
type Org = { organizationId: string; tenantId: string; tenants: string[]; subjectId: string; accountId: string };

async function organization(tenantCount = 1): Promise<Org> {
  const organizationId = randomUUID();
  const tenants = Array.from({ length: tenantCount }, () => randomUUID());
  await owner.organization.create({ data: { id: organizationId, name: "Status", slug: `st-${suffix}-${++orgs}` } });
  for (const id of tenants) await owner.tenant.create({ data: { id, organizationId, name: "Production" } });
  const tenantId = tenants[0];
  const connection = await owner.providerConnection.create({ data: { organizationId, providerType: "LUXIA_LOCAL", externalScopeId: tenantId, name: "LUXIA Local" } });
  await owner.providerConnectionTenantScope.create({ data: { organizationId, tenantId, providerConnectionId: connection.id } });
  const subject = await owner.subject.create({ data: { organizationId, tenantId, type: "HUMAN", name: "Person", lifecycleState: "ACTIVE" } });
  const account = await owner.identityAccount.create({ data: { organizationId, tenantId, subjectId: subject.id, providerConnectionId: connection.id, externalObjectId: randomUUID() } });
  return { organizationId, tenantId, tenants, subjectId: subject.id, accountId: account.id };
}
const scope = (org: Org) => ({ organizationId: org.organizationId, tenantId: org.tenantId });
const signIn = (org: Org) => SessionStore.createSession({ ...scope(org), subjectId: org.subjectId, identityAccountId: org.accountId });
const statusOf = async (org: Org) => (await owner.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).status;
const openSessions = (org: Org) => owner.session.count({ where: { organizationId: org.organizationId, revokedAt: null } });
const settle = (promise: Promise<unknown>) => promise.then(() => "ok" as const, (error: unknown) => error);
const text = (error: unknown) => String(error instanceof Error ? error.message : error);
const resolveCanonical = (hash: string) => rawPrisma.$queryRaw<Array<{ id: string; organizationId: string; tenantId: string; subjectId: string;
  identityAccountId: string; expiresAt: Date; revokedAt: Date | null; lastSeenAt: Date | null; scope: string }>>`SELECT * FROM luxia_session_resolve(${hash})`;
const resolveWrapper = (hash: string) => rawPrisma.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM resolve_session(${hash})`;
const insertSession = (org: Org, data: Partial<{ revokedAt: Date; scope: "FULL" | "RECOVERY"; expiresAt: Date; createdAt: Date }> = {}) => {
  const id = sha(randomUUID());
  return owner.session.create({ data: { id, ...scope(org), subjectId: org.subjectId, identityAccountId: org.accountId,
    expiresAt: data.expiresAt ?? new Date(Date.now() + 3_600_000), ...data } }).then(() => id);
};

async function effects(tx: Prisma.TransactionClient, org: Org, status: Status) {
  if (status === "ACTIVE") return;
  await tx.$executeRaw`UPDATE "Session" SET "revokedAt" = (now() AT TIME ZONE 'UTC') WHERE "organizationId" = ${org.organizationId} AND "revokedAt" IS NULL`;
  if (status !== "CLOSED") return;
  await tx.$executeRaw`UPDATE "Invitation" SET "revokedAt" = (now() AT TIME ZONE 'UTC'), "pendingChallengeHash" = NULL, "pendingExpiresAt" = NULL
    WHERE "organizationId" = ${org.organizationId} AND "acceptedAt" IS NULL AND "revokedAt" IS NULL`;
  await tx.$executeRaw`UPDATE "OrganizationDomain" SET "status" = CASE WHEN "status" = 'VERIFIED' THEN 'LOST'::"OrganizationDomainStatus" ELSE 'EXPIRED'::"OrganizationDomainStatus" END
    WHERE "organizationId" = ${org.organizationId} AND "status" IN ('PENDING', 'VERIFIED')`;
}
type TransitionOptions = { lock?: "all" | "first" | "none"; effects?: "after" | "before" | "none"; immediate?: boolean;
  client?: PrismaClient; held?: () => void; pause?: Promise<void> };
/** What the B4 procedure does: governance lock of every tenant, then the status, then the effects. */
function transition(org: Org, status: Status, options: TransitionOptions = {}) {
  return (options.client ?? owner).$transaction(async (tx) => {
    const tenants = options.lock === "none" ? [] : options.lock === "first" ? [org.tenants[0]] : [...org.tenants].sort();
    for (const tenantId of tenants) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${org.organizationId}:${tenantId}`}, 0))::text`;
    if (options.effects === "before") await effects(tx, org, status);
    await tx.$executeRaw`UPDATE "Organization" SET "status" = ${status}::"OrganizationStatus" WHERE "id" = ${org.organizationId}`;
    if ((options.effects ?? "after") === "after") await effects(tx, org, status);
    // Surfaces the deferred completeness check here, with its own message, instead of at commit.
    if (options.immediate) await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    options.held?.();
    if (options.pause) await options.pause;
  }, { maxWait: 10_000, timeout: 60_000 });
}

function gate() { let open!: () => void; const promise = new Promise<void>((resolve) => { open = resolve; }); return { promise, open }; }
/** Waits until `count` locks are being waited for: advisory ones, or row/transaction ones. */
async function waitBlocked(count: number, kind: "advisory" | "row") {
  for (let attempt = 0; ; attempt++) {
    const [{ waiting }] = await owner.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_locks
      WHERE NOT granted AND database IS NOT DISTINCT FROM (SELECT oid FROM pg_database WHERE datname = current_database())
        AND (locktype = 'advisory') = ${kind === "advisory"}`;
    if (waiting >= count) return;
    if (attempt > 400) throw new Error(`NOT_BLOCKED_${kind}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
/** Holds the governance lock while every operation starts and queues on it, then releases it. */
async function race(org: Org, operations: Array<() => Promise<unknown>>) {
  const release = gate(); const ready = gate();
  const holder = owner.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${org.organizationId}:${org.tenantId}`}, 0))::text`;
    ready.open(); await release.promise;
  }, { timeout: 60_000 });
  await ready.promise;
  const settled = operations.map((operation) => settle(operation()));
  await waitBlocked(operations.length, "advisory");
  release.open(); await holder;
  return Promise.all(settled);
}
async function openInvitation(org: Org) {
  const token = randomBytes(32).toString("base64url");
  const invitee = await owner.subject.create({ data: { ...scope(org), type: "HUMAN", name: "Invitee", lifecycleState: "PROVISIONING" } });
  const id = randomUUID();
  await owner.$executeRaw`INSERT INTO "Invitation" ("id","organizationId","tenantId","subjectId","tokenHash","role","invitedBySubjectId","createdAt","expiresAt","updatedAt")
    VALUES (${id}, ${org.organizationId}, ${org.tenantId}, ${invitee.id}, ${sha(token)}, 'MEMBER'::"InvitationRole", ${org.subjectId}, now(), now(), now())`;
  return { id, token };
}
const resolveInvitation = (token: string) => rawPrisma.$queryRaw<Array<{ invitation_id: string }>>`SELECT * FROM luxia_invitation_resolve(${sha(token)})`;

function psql(url: string, args: string[]) {
  const target = new URL(url); target.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8" });
}
function psqlOk(url: string, args: string[]) {
  const result = psql(url, args);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout;
}

describe.runIf(enabled)("Organization.status and Session.scope (PostgreSQL)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
  });
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("drill: backfill changes no existing data, rollback restores the exact previous state, and the migration applies again", () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_status_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const digest = () => psqlOk(url, ["-f", "scripts/certification/organization-status-business-digest.sql"]);
    const definitions = () => psqlOk(url, ["-c", `SELECT p.proname || ':' || pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND (p.proname LIKE 'luxia_%' OR p.proname = 'resolve_session') ORDER BY p.proname`, "-c",
      `SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`]).replace(/\r/g, "");
    const one = (sql: string) => psqlOk(url, ["-c", sql]).trim();
    try {
      const prior = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
      expect(prior.length).toBe(20);
      for (const dir of prior) psqlOk(url, ["-f", `prisma/migrations/${dir}/migration.sql`]);
      psqlOk(url, ["-f", "tests/resources/fixtures/self-onboarding-backfill-seed.sql"]);
      psqlOk(url, ["-f", "tests/resources/fixtures/organization-status-seed.sql"]);
      const before = digest(); const definitionsBefore = definitions();
      expect(before).toMatch(/^Session\|3\|/m);
      expect(before).toMatch(/^Organization\|2\|/m);

      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(digest()).toBe(before);
      expect(one(`SELECT count(*) FROM "Organization" WHERE "status" <> 'ACTIVE' OR "statusChangedAt" IS NOT NULL`)).toBe("0");
      expect(one(`SELECT count(*) FROM "Session" WHERE "scope" <> 'FULL'`)).toBe("0");
      expect(one(`SELECT count(*) FROM resolve_session('${sha("drill-open")}')`)).toBe("1");
      expect(one(`SELECT scope FROM luxia_session_resolve('${sha("drill-open")}')`)).toBe("FULL");

      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(digest()).toBe(before);
      expect(definitions()).toBe(definitionsBefore);
      expect(one(`SELECT count(*) FROM information_schema.columns WHERE table_name IN ('Organization', 'Session') AND column_name IN ('status', 'statusChangedAt', 'scope')`)).toBe("0");

      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(digest()).toBe(before);
      // Once a status is in use, the rollback refuses (forward fix only).
      psqlOk(url, ["-1", "-c", `SELECT pg_advisory_xact_lock(hashtextextended('resource-governance:4841428a-80b4-4f07-bb3f-c94612dfd4a2:c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', 0));
        UPDATE "Organization" SET "status" = 'SUSPENDED' WHERE "id" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2';
        UPDATE "Session" SET "revokedAt" = now() WHERE "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2' AND "revokedAt" IS NULL;`]);
      const refused = psql(url, ["-1", "-f", ROLLBACK]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/ROLLBACK_REFUSED_ORGANIZATION_STATUS_IN_USE/);
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 180_000);

  it("a new organization is always ACTIVE", async () => {
    const org = await organization();
    expect(await owner.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).toMatchObject({ status: "ACTIVE", statusChangedAt: null });
    await expect(owner.$executeRaw`INSERT INTO "Organization" ("id","name","status","updatedAt") VALUES (${randomUUID()}, 'X', 'SUSPENDED', now())`).rejects.toThrow(/ORGANIZATION_STATUS_INITIAL/);
    await expect(rawPrisma.$executeRaw`INSERT INTO "Organization" ("id","name","status","updatedAt") VALUES (${randomUUID()}, 'X', 'CLOSED', now())`).rejects.toThrow(/ORGANIZATION_STATUS_INITIAL/);
  });

  it("transitions: allowed pairs only, by the operator role, CLOSED final for the whole row (M2, M3)", async () => {
    const org = await organization();
    await transition(org, "SUSPENDED");
    const suspended = await owner.organization.findUniqueOrThrow({ where: { id: org.organizationId } });
    expect(suspended.status).toBe("SUSPENDED");
    expect(suspended.statusChangedAt).toBeInstanceOf(Date);
    await transition(org, "ACTIVE");
    await owner.$executeRaw`UPDATE "Organization" SET "name" = 'Renamed', "statusChangedAt" = '2000-01-01' WHERE "id" = ${org.organizationId}`;
    expect((await owner.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).statusChangedAt?.getUTCFullYear()).toBeGreaterThan(2020);
    await transition(org, "SUSPENDED");
    await transition(org, "CLOSED");
    expect(await statusOf(org)).toBe("CLOSED");
    for (const status of ["ACTIVE", "SUSPENDED"] as const) await expect(transition(org, status)).rejects.toThrow(/ORGANIZATION_CLOSED/);
    await expect(owner.$executeRaw`UPDATE "Organization" SET "name" = 'Reopen?' WHERE "id" = ${org.organizationId}`).rejects.toThrow(/ORGANIZATION_CLOSED/);
    const direct = await organization();
    await transition(direct, "CLOSED");
    expect(await statusOf(direct)).toBe("CLOSED");
    // M3: app_user can never change the status, even holding the lock.
    const other = await organization();
    await expect(transition(other, "SUSPENDED", { client: rawPrisma })).rejects.toThrow(/ORGANIZATION_STATUS_OPERATOR_ONLY/);
    expect(await statusOf(other)).toBe("ACTIVE");
  });

  it("A1: a transition needs the governance lock of every tenant, inside a transaction", async () => {
    const org = await organization(2);
    await expect(transition(org, "SUSPENDED", { lock: "none" })).rejects.toThrow(/GOVERNANCE_LOCK_REQUIRED/);
    await expect(transition(org, "SUSPENDED", { lock: "first" })).rejects.toThrow(/GOVERNANCE_LOCK_REQUIRED/);
    await expect(owner.$executeRaw`UPDATE "Organization" SET "status" = 'SUSPENDED' WHERE "id" = ${org.organizationId}`).rejects.toThrow(/GOVERNANCE_LOCK_REQUIRED/);
    expect(await statusOf(org)).toBe("ACTIVE");
    await transition(org, "SUSPENDED");
    expect(await statusOf(org)).toBe("SUSPENDED");
  });

  it("M1: a transition without its effects fails at commit and writes nothing", async () => {
    const org = await organization();
    await signIn(org);
    await expect(transition(org, "SUSPENDED", { effects: "none", immediate: true })).rejects.toThrow(/ORGANIZATION_TRANSITION_INCOMPLETE_SESSIONS/);
    await expect(transition(org, "SUSPENDED", { effects: "none" })).rejects.toThrow();
    expect(await statusOf(org)).toBe("ACTIVE");
    expect(await openSessions(org)).toBe(1);
    // CLOSED also needs the open invitation revoked and the verified domain released.
    await openInvitation(org);
    await owner.organizationDomain.create({ data: { ...scope(org), domain: `closed-${suffix}.example`, status: "VERIFIED", verifiedAt: new Date(),
      challengeHash: sha(randomUUID()), challengeExpiresAt: new Date(Date.now() + 86_400_000) } });
    await expect(owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${org.organizationId}:${org.tenantId}`}, 0))::text`;
      await tx.$executeRaw`UPDATE "Organization" SET "status" = 'CLOSED' WHERE "id" = ${org.organizationId}`;
      await effects(tx, org, "SUSPENDED"); // sessions only
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    })).rejects.toThrow(/ORGANIZATION_TRANSITION_INCOMPLETE_CLOSED/);
    expect(await statusOf(org)).toBe("ACTIVE");
    await transition(org, "CLOSED");
    expect(await owner.organizationDomain.findFirstOrThrow({ where: { organizationId: org.organizationId } })).toMatchObject({ status: "LOST" });
    expect(await owner.invitation.count({ where: { organizationId: org.organizationId, acceptedAt: null, revokedAt: null } })).toBe(0);
  });

  it("A3, A4, M5: sessions are append-only; a revocation is never refused for its timestamp", async () => {
    const org = await organization();
    const { session } = await signIn(org);
    const id = session.id;
    const update = (data: Prisma.SessionUpdateInput) => withTenantDb(scope(org), (tx) => tx.session.update({ where: { id }, data }));
    await expect(withTenantDb(scope(org), (tx) => tx.session.create({ data: { id: sha(randomUUID()), ...scope(org), subjectId: org.subjectId,
      identityAccountId: org.accountId, expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() } }))).rejects.toThrow(/SESSION_INVALID_INITIAL_STATE/);
    await update({ lastSeenAt: new Date() });
    await expect(update({ expiresAt: new Date(Date.now() + 9 * 86_400_000) })).rejects.toThrow(/SESSION_IMMUTABLE/);
    await expect(update({ scope: "RECOVERY" })).rejects.toThrow(/SESSION_IMMUTABLE/);
    await expect(update({ revokedAt: new Date(), lastSeenAt: new Date(Date.now() + 60_000) })).rejects.toThrow(/SESSION_REVOCATION_ONLY/);
    await update({ revokedAt: new Date(session.createdAt.getTime() - 60_000) }); // application clock behind the database
    await expect(update({ revokedAt: new Date() })).rejects.toThrow(/SESSION_REVOKED_IMMUTABLE/);
    await expect(update({ revokedAt: null })).rejects.toThrow(/SESSION_REVOKED_IMMUTABLE/);
    await expect(update({ lastSeenAt: new Date() })).rejects.toThrow(/SESSION_REVOKED_IMMUTABLE/);
    // 9.4: a RECOVERY session lives 15 minutes at most.
    const now = new Date();
    await expect(insertSession(org, { scope: "RECOVERY", createdAt: now, expiresAt: new Date(now.getTime() + 16 * 60_000) })).rejects.toThrow(/Session_recovery_lifetime|23514/);
    await insertSession(org, { scope: "RECOVERY", createdAt: now, expiresAt: new Date(now.getTime() + 15 * 60_000) });
  });

  it("A2, A5: one canonical resolver; the wrapper returns its FULL rows only; SUSPENDED and CLOSED resolve nothing", async () => {
    const org = await organization();
    const { rawToken, session } = await signIn(org);
    const recovery = await insertSession(org, { scope: "RECOVERY", createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60_000) });
    const [canonical] = await resolveCanonical(session.id);
    expect(canonical.scope).toBe("FULL");
    const { scope: _scope, ...withoutScope } = canonical;
    expect(await resolveWrapper(session.id)).toEqual([withoutScope]);
    expect((await resolveCanonical(recovery))[0].scope).toBe("RECOVERY");
    expect(await resolveWrapper(recovery)).toEqual([]);
    expect(await resolveCanonical("not-a-hash")).toEqual([]);
    expect(await SessionStore.getSession(rawToken)).toMatchObject({ id: session.id });

    await transition(org, "SUSPENDED");
    expect(await resolveCanonical(session.id)).toEqual([]);
    expect(await resolveWrapper(session.id)).toEqual([]);
    expect(await SessionStore.getSession(rawToken)).toBeNull();
    await expect(signIn(org)).rejects.toThrow(/ORGANIZATION_NOT_ACTIVE/);
    // The status alone decides: back to ACTIVE, the (revoked) row resolves again, so the filter is the status.
    await transition(org, "ACTIVE");
    expect((await resolveCanonical(session.id))[0].revokedAt).toBeInstanceOf(Date);
    expect(await SessionStore.getSession(rawToken)).toBeNull();
    await transition(org, "CLOSED");
    expect(await resolveCanonical(session.id)).toEqual([]);
    await expect(signIn(org)).rejects.toThrow(/ORGANIZATION_NOT_ACTIVE/);
  });

  it("invitations: SUSPENDED keeps them open but they cannot be resolved, started or accepted; revoking always works", async () => {
    const org = await organization();
    const open = await openInvitation(org);
    const kept = await openInvitation(org);
    expect(await resolveInvitation(open.token)).toHaveLength(1);
    await transition(org, "SUSPENDED");
    expect(await resolveInvitation(open.token)).toEqual([]);
    const tenantUpdate = (id: string, sql: Prisma.Sql) => withTenantDb(scope(org), (tx) => tx.$executeRaw`UPDATE "Invitation" SET ${sql} WHERE "id" = ${id}`);
    await expect(tenantUpdate(open.id, Prisma.sql`"pendingChallengeHash" = ${sha("c")}, "pendingExpiresAt" = now() + interval '10 minutes'`)).rejects.toThrow(/ORGANIZATION_NOT_ACTIVE/);
    await expect(tenantUpdate(open.id, Prisma.sql`"acceptedAt" = now()`)).rejects.toThrow(/ORGANIZATION_NOT_ACTIVE/);
    await expect(openInvitation(org)).rejects.toThrow(/ORGANIZATION_NOT_ACTIVE/);
    await tenantUpdate(kept.id, Prisma.sql`"revokedAt" = now()`);
    await transition(org, "ACTIVE");
    expect(await resolveInvitation(open.token)).toHaveLength(1);
    expect(await resolveInvitation(kept.token)).toEqual([]);
  });

  it("domains: SUSPENDED keeps verified domains and blocks adding or verifying; CLOSED releases them for another organization", async () => {
    const [a, b] = [await organization(), await organization()];
    const domain = `status-${suffix}.example`;
    const add = (org: Org, name: string) => owner.organizationDomain.create({ data: { ...scope(org), domain: name, challengeHash: sha(randomUUID()),
      challengeExpiresAt: new Date(Date.now() + 86_400_000) } });
    const verify = (org: Org, id: string) => withTenantDb(scope(org), (tx) => tx.$executeRaw`UPDATE "OrganizationDomain" SET "status" = 'VERIFIED', "verifiedAt" = now() WHERE "id" = ${id}`);
    const owned = await add(a, domain);
    await verify(a, owned.id);
    const pending = await add(a, `pending-${suffix}.example`);
    await transition(a, "SUSPENDED");
    expect(await owner.organizationDomain.findUniqueOrThrow({ where: { id: owned.id } })).toMatchObject({ status: "VERIFIED" });
    await expect(verify(a, pending.id)).rejects.toThrow(/ORGANIZATION_NOT_ACTIVE/);
    await expect(add(a, `new-${suffix}.example`)).rejects.toThrow(/ORGANIZATION_NOT_ACTIVE/);
    const claim = await add(b, domain);
    await expect(verify(b, claim.id)).rejects.toThrow(/23505/); // still owned by the suspended organization
    await transition(a, "CLOSED");
    expect(await owner.organizationDomain.findUniqueOrThrow({ where: { id: owned.id } })).toMatchObject({ status: "LOST" });
    expect(await owner.organizationDomain.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: "EXPIRED" });
    await verify(b, claim.id);
    expect(await owner.organizationDomain.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ status: "VERIFIED" });
  });

  it("race: transition first, a sign-in waits on the organization row and is refused", async () => {
    const org = await organization();
    const pause = gate(); const held = gate();
    const t = transition(org, "SUSPENDED", { held: held.open, pause: pause.promise });
    await held.promise;
    const s = settle(signIn(org));
    await waitBlocked(1, "row");
    pause.open(); await t;
    expect(text(await s)).toMatch(/ORGANIZATION_NOT_ACTIVE/);
    expect(await openSessions(org)).toBe(0);
  }, 60_000);

  it("race: sign-in first, the transition waits, then revokes the new session too", async () => {
    const org = await organization();
    const pause = gate(); const held = gate();
    const id = sha(randomUUID());
    const s = withTenantDb(scope(org), async (tx) => {
      await tx.$executeRaw`SELECT luxia_organization_lock_active(${org.organizationId})`;
      await tx.session.create({ data: { id, ...scope(org), subjectId: org.subjectId, identityAccountId: org.accountId, expiresAt: new Date(Date.now() + 3_600_000) } });
      held.open(); await pause.promise;
    });
    await held.promise;
    const t = settle(transition(org, "SUSPENDED"));
    await waitBlocked(1, "row");
    pause.open(); await s;
    expect(await t).toBe("ok");
    expect(await statusOf(org)).toBe("SUSPENDED");
    expect((await owner.session.findUniqueOrThrow({ where: { id } })).revokedAt).toBeInstanceOf(Date);
  }, 60_000);

  it("race: effects applied before the status change miss the late session, so the whole transition is refused", async () => {
    const org = await organization();
    const pause = gate(); const held = gate();
    const id = sha(randomUUID());
    const s = withTenantDb(scope(org), async (tx) => {
      await tx.$executeRaw`SELECT luxia_organization_lock_active(${org.organizationId})`;
      await tx.session.create({ data: { id, ...scope(org), subjectId: org.subjectId, identityAccountId: org.accountId, expiresAt: new Date(Date.now() + 3_600_000) } });
      held.open(); await pause.promise;
    });
    await held.promise;
    const t = settle(transition(org, "SUSPENDED", { effects: "before" }));
    await waitBlocked(1, "row");
    pause.open(); await s;
    expect(await t).not.toBe("ok");
    expect(await statusOf(org)).toBe("ACTIVE");
    expect((await owner.session.findUniqueOrThrow({ where: { id } })).revokedAt).toBeNull();
  }, 60_000);

  it("race: transitions, invitation acceptances and grant writers queue on the governance lock, in any order, without deadlock", async () => {
    for (const order of [0, 1]) {
      const org = await organization();
      const entitlement = await owner.entitlement.create({ data: { ...scope(org), key: "subjects.read", resource: "subjects", action: "read" } });
      const invitation = await openInvitation(org);
      const principalName = `member-${randomUUID().slice(0, 8)}`;
      const passkey = softwarePasskey();
      const begin = await beginAcceptance({ token: invitation.token, principalName }, "localhost");
      const operations = [
        () => transition(org, "SUSPENDED"),
        () => completeAcceptance({ token: invitation.token, principalName, ...passkey.register(begin.challenge) }, { rpId: "localhost", origin: "http://localhost:3000" }),
        () => grantAssignment({ ...scope(org), subjectId: org.subjectId }, { subjectId: org.subjectId, entitlementId: entitlement.id }, `race:${randomUUID()}`),
      ];
      const results = await race(org, order ? [...operations].reverse() : operations);
      const [transitioned, accepted, granted] = order ? [...results].reverse() : results;
      expect(transitioned, `order ${order}`).toBe("ok");
      expect(granted, `order ${order}`).toBe("ok");
      if (accepted !== "ok") expect(text(accepted), `order ${order}`).toMatch(/ORGANIZATION_NOT_ACTIVE/);
      expect(await statusOf(org)).toBe("SUSPENDED");
      expect(await openSessions(org)).toBe(0);
    }
  }, 120_000);

  it("race: two closes queue on the lock; the second sees CLOSED and is refused", async () => {
    const org = await organization();
    const results = await race(org, [() => transition(org, "CLOSED"), () => transition(org, "CLOSED")]);
    expect(results.filter((result) => result === "ok")).toHaveLength(1);
    expect(text(results.find((result) => result !== "ok"))).toMatch(/ORGANIZATION_CLOSED/);
    expect(await statusOf(org)).toBe("CLOSED");
  }, 60_000);
});
