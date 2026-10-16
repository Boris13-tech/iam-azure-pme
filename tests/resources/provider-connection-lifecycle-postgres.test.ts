import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { SessionCreationDeniedError, SessionStore } from "../../lib/auth/session-store";
import { resolveLoginOrganization } from "../../lib/auth/organization-login";
import { lockOrganizationActive, lockProviderConnectionActive } from "../../lib/organizations/lifecycle";
import { createProviderConnection } from "../../lib/admin/canonical-administration";
import { applyConnectionTransition, planConnectionTransition, type ConnectionAction } from "../../lib/admin/provider-connection-lifecycle";
import { LUXIA_ORG_ADMIN_V1 } from "../../lib/auth/native-role-catalog";
import { GOVERNANCE_ADMIN_V2 } from "../../lib/resources/admin-bundle";

// Sovereign providers, phase F2: ProviderConnection lifecycle and the sign-in kill switch on PostgreSQL.
// Design: docs/architecture/F2-PROVIDER-CONNECTION-LIFECYCLE.md. app_user (rawPrisma) is the runtime;
// owner (BYPASSRLS) checks the database guards directly and reads what the runtime cannot.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261014090000_provider_connection_lifecycle";
const ROLLBACK = "docs/operations/PROVIDER-CONNECTION-LIFECYCLE-ROLLBACK.sql";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const suffix = randomUUID().slice(0, 8);
const change = () => `test:${randomUUID()}`;
let owner: PrismaClient;

type Org = { organizationId: string; tenantId: string; slug: string; admin: string; member: string;
  local: string; federated: string; adminLocal: string; adminFederated: string; memberFederated: string };
async function organization(name: string): Promise<Org> {
  const organizationId = randomUUID(); const tenantId = randomUUID();
  const scope = { organizationId, tenantId };
  const slug = `${name}-${suffix}`;
  await owner.organization.create({ data: { id: organizationId, name, slug } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const local = await owner.providerConnection.create({ data: { organizationId, providerType: "LUXIA_LOCAL", externalScopeId: tenantId, name: "LUXIA Local" } });
  const federated = await owner.providerConnection.create({ data: { organizationId, providerType: "MICROSOFT_ENTRA", externalScopeId: `directory-${randomUUID()}`, name: "Federated" } });
  for (const connection of [local, federated]) await owner.providerConnectionTenantScope.create({ data: { ...scope, providerConnectionId: connection.id } });
  const admin = (await owner.subject.create({ data: { ...scope, type: "HUMAN", name: "Admin", lifecycleState: "ACTIVE" } })).id;
  const member = (await owner.subject.create({ data: { ...scope, type: "HUMAN", name: "Member", lifecycleState: "ACTIVE" } })).id;
  const account = (subjectId: string, providerConnectionId: string) =>
    owner.identityAccount.create({ data: { ...scope, subjectId, providerConnectionId, externalObjectId: randomUUID() } }).then((row) => row.id);
  const org = { organizationId, tenantId, slug, admin, member, local: local.id, federated: federated.id,
    adminLocal: await account(admin, local.id), adminFederated: await account(admin, federated.id), memberFederated: await account(member, federated.id) };
  for (const key of [...LUXIA_ORG_ADMIN_V1.entitlements, ...GOVERNANCE_ADMIN_V2]) {
    const [resource, action] = key.split(".");
    const entitlement = await owner.entitlement.create({ data: { ...scope, key, resource, action } });
    await owner.assignment.create({ data: { ...scope, subjectId: admin, entitlementId: entitlement.id, source: "DIRECT", sourceRef: "test" } });
  }
  return org;
}
const scope = (org: Org) => ({ organizationId: org.organizationId, tenantId: org.tenantId });
const as = (org: Org, subjectId = org.admin) => ({ ...scope(org), subjectId });
const signIn = (org: Org, subjectId: string, identityAccountId: string) => SessionStore.createSession({ ...scope(org), subjectId, identityAccountId });
const statusOf = async (id: string) => (await owner.providerConnection.findUniqueOrThrow({ where: { id } })).status;
const settle = (promise: Promise<unknown>) => promise.then(() => "ok" as const, (error: unknown) => error);
const text = (error: unknown) => String(error instanceof Error ? error.message : error);
const reason = (error: unknown) => (error as { code?: string; reason?: string }).code ?? (error as { reason?: string }).reason ?? text(error);
const isOpen = async (id: string) => (await owner.session.findUniqueOrThrow({ where: { id } })).revokedAt === null;
const journal = (org: Org) => owner.canonicalAdminAuditEvent.findMany({ where: { organizationId: org.organizationId }, orderBy: { occurredAt: "asc" } });
const authority = async (org: Org) => ({
  subjects: await owner.subject.count({ where: { organizationId: org.organizationId } }),
  accounts: await owner.identityAccount.count({ where: { organizationId: org.organizationId, status: "ACTIVE" } }),
  assignments: await owner.assignment.count({ where: { organizationId: org.organizationId, status: "ACTIVE" } }),
  connections: await owner.providerConnection.count({ where: { organizationId: org.organizationId } }),
});
const lockGovernance = (tx: Prisma.TransactionClient, org: Org) =>
  tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${org.organizationId}:${org.tenantId}`}, 0))::text`;
type Status = "DRAFT" | "TESTING" | "ACTIVE" | "DISABLED" | "QUARANTINED";
/** A status change straight in the database, as the owner: governance lock, status, effects, deferred checks now. */
function setStatus(org: Org, id: string, status: Status, options: { lock?: boolean; revoke?: boolean; held?: () => void; pause?: Promise<void> } = {}) {
  return owner.$transaction(async (tx) => {
    if (options.lock ?? true) await lockGovernance(tx, org);
    await tx.$executeRaw`UPDATE "ProviderConnection" SET "status" = ${status}::"ProviderConnectionStatus" WHERE "id" = ${id}`;
    if (options.revoke ?? status === "QUARANTINED") await tx.$executeRaw`UPDATE "Session" s SET "revokedAt" = (now() AT TIME ZONE 'UTC')
      FROM "IdentityAccount" ia WHERE ia."id" = s."identityAccountId" AND ia."providerConnectionId" = ${id} AND s."revokedAt" IS NULL`;
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    options.held?.();
    if (options.pause) await options.pause;
  }, { maxWait: 10_000, timeout: 60_000 });
}
async function transition(org: Org, id: string, action: ConnectionAction, auth = as(org)) {
  const plan = await planConnectionTransition(auth, change(), id, action);
  return { plan, result: await applyConnectionTransition(auth, change(), id, action, plan.planDigest) };
}

function gate() { let open!: () => void; const promise = new Promise<void>((resolve) => { open = resolve; }); return { promise, open }; }
async function waitBlocked(count: number) {
  for (let attempt = 0; ; attempt++) {
    const [{ waiting }] = await owner.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_locks
      WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`;
    if (waiting >= count) return;
    if (attempt > 400) throw new Error("NOT_BLOCKED");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function psql(url: string, args: string[]) {
  const target = new URL(url); target.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8" });
}
function psqlOk(url: string, args: string[]) {
  const result = psql(url, args);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout;
}

describe.runIf(enabled)("ProviderConnection lifecycle and sign-in kill switch (PostgreSQL)", () => {
  let a: Org, b: Org;
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    a = await organization("pca"); b = await organization("pcb");
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("drill: no existing data changes, the rollback restores the exact previous state, and the migration applies again", () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_f2_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const digest = () => psqlOk(url, ["-f", "scripts/certification/provider-connection-business-digest.sql"]);
    const definitions = () => psqlOk(url, ["-c", `SELECT p.proname || ':' || pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'luxia_%' ORDER BY p.proname`, "-c",
      `SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`, "-c",
      `SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants WHERE table_name = 'ProviderConnection' AND grantee = 'app_user'`]).replace(/\r/g, "");
    const one = (sql: string) => psqlOk(url, ["-c", sql]).trim();
    try {
      const prior = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
      expect(prior.length).toBeGreaterThan(20);
      // One transaction per migration, as Prisma applies them (several take table locks).
      for (const dir of prior) psqlOk(url, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      // app_user's table privileges as in Production before F2 (DELETE included).
      psqlOk(url, ["-c", `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user`]);
      for (const seed of ["self-onboarding-backfill-seed", "organization-status-seed", "provider-connection-seed"])
        psqlOk(url, ["-f", `tests/resources/fixtures/${seed}.sql`]);
      const before = digest(); const definitionsBefore = definitions();
      expect(before).toMatch(/^ProviderConnection\|2\|/m);
      expect(before).toMatch(/^Session\|4\|/m);
      expect(definitionsBefore).toMatch(/DELETE,INSERT,SELECT,UPDATE/);

      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(digest()).toBe(before);
      expect(one(`SELECT count(*) FROM "ProviderConnection" WHERE "status" <> 'ACTIVE' OR "statusChangedAt" IS NOT NULL`)).toBe("0");
      expect(one(`SELECT has_table_privilege('app_user', '"ProviderConnection"', 'DELETE')`)).toBe("f");
      expect(one(`SELECT count(*) FROM "Session" WHERE "revokedAt" IS NULL`)).toBe("3");

      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(digest()).toBe(before);
      expect(definitions()).toBe(definitionsBefore);
      expect(one(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'ProviderConnection' AND column_name IN ('status', 'statusChangedAt')`)).toBe("0");
      expect(one(`SELECT count(*) FROM pg_type WHERE typname = 'ProviderConnectionStatus'`)).toBe("0");

      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(digest()).toBe(before);
      // Once a status is in use, the rollback refuses (forward fix only).
      psqlOk(url, ["-1", "-c", `SELECT pg_advisory_xact_lock(hashtextextended('resource-governance:4841428a-80b4-4f07-bb3f-c94612dfd4a2:c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', 0));
        UPDATE "ProviderConnection" SET "status" = 'DISABLED' WHERE "id" = '0b9d0b8e-3333-4c2a-9a55-000000000001';`]);
      const refused = psql(url, ["-1", "-f", ROLLBACK]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/ROLLBACK_REFUSED_CONNECTION_STATUS_IN_USE/);
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 180_000);

  it("a new connection is DRAFT or ACTIVE, LUXIA_LOCAL only ACTIVE; a connection is never deleted and its identity never changes", async () => {
    const draft = await owner.providerConnection.create({ data: { organizationId: a.organizationId, providerType: "MICROSOFT_ENTRA", status: "DRAFT", externalScopeId: `d-${randomUUID()}`, name: "Draft", statusChangedAt: new Date() } });
    expect(draft).toMatchObject({ status: "DRAFT", statusChangedAt: null });
    for (const status of ["TESTING", "DISABLED", "QUARANTINED"] as const)
      expect(text(await settle(owner.providerConnection.create({ data: { organizationId: a.organizationId, providerType: "MICROSOFT_ENTRA", status, externalScopeId: `x-${randomUUID()}`, name: "X" } })))).toMatch(/PROVIDER_CONNECTION_STATUS_INITIAL/);
    expect(text(await settle(owner.providerConnection.create({ data: { organizationId: a.organizationId, providerType: "LUXIA_LOCAL", status: "DRAFT", externalScopeId: `l-${randomUUID()}`, name: "L" } })))).toMatch(/PROVIDER_CONNECTION_STATUS_INITIAL/);
    // Never deleted: the owner is refused by the guard, app_user has no DELETE privilege at all.
    expect(text(await settle(owner.$executeRaw`DELETE FROM "ProviderConnection" WHERE "id" = ${draft.id}`))).toMatch(/PROVIDER_CONNECTION_IMMUTABLE/);
    expect(text(await settle(withTenantDb(scope(a), (tx) => tx.$executeRaw`DELETE FROM "ProviderConnection" WHERE "id" = ${draft.id}`)))).toMatch(/permission denied/);
    expect(text(await settle(owner.$executeRaw`UPDATE "ProviderConnection" SET "providerType" = 'LDAP' WHERE "id" = ${draft.id}`))).toMatch(/PROVIDER_CONNECTION_IMMUTABLE/);
    expect(text(await settle(owner.$executeRaw`UPDATE "ProviderConnection" SET "organizationId" = ${b.organizationId} WHERE "id" = ${draft.id}`))).toMatch(/PROVIDER_CONNECTION_IMMUTABLE|violates foreign key/);
    // The external scope may change only before the first activation.
    await owner.$executeRaw`UPDATE "ProviderConnection" SET "externalScopeId" = ${`d2-${randomUUID()}`} WHERE "id" = ${draft.id}`;
    expect(text(await settle(owner.$executeRaw`UPDATE "ProviderConnection" SET "externalScopeId" = 'other' WHERE "id" = ${a.federated}`))).toMatch(/PROVIDER_CONNECTION_SCOPE_IMMUTABLE/);
    // A rename changes nothing in the status history.
    await owner.$executeRaw`UPDATE "ProviderConnection" SET "name" = 'Renamed' WHERE "id" = ${draft.id}`;
    expect(await owner.providerConnection.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: "DRAFT", statusChangedAt: null });
  });

  it("transitions: allowed pairs only, under the governance lock; LUXIA_LOCAL never changes", async () => {
    const org = await organization("pct");
    const draft = await owner.providerConnection.create({ data: { organizationId: org.organizationId, providerType: "GITHUB", status: "DRAFT", externalScopeId: `g-${randomUUID()}`, name: "G" } });
    expect(text(await settle(setStatus(org, draft.id, "ACTIVE")))).toMatch(/PROVIDER_CONNECTION_STATUS_TRANSITION/);
    expect(text(await settle(setStatus(org, draft.id, "TESTING", { lock: false })))).toMatch(/GOVERNANCE_LOCK_REQUIRED/);
    for (const [to, ok] of [["TESTING", true], ["DISABLED", false], ["DRAFT", false]] as const) {
      const outcome = await settle(setStatus(org, draft.id, to));
      if (ok) expect(outcome, to).toBe("ok"); else expect(text(outcome), to).toMatch(/PROVIDER_CONNECTION_STATUS_TRANSITION/);
    }
    // F4 (S5): TESTING -> ACTIVE is an allowed pair, but the database also requires activation evidence, which only a
    // configured generic OIDC connection can have (tests/resources/provider-connection-proof-postgres.test.ts).
    expect(text(await settle(setStatus(org, draft.id, "ACTIVE")))).toMatch(/PROVIDER_CONNECTION_ACTIVATION_EVIDENCE/);
    const live = await owner.providerConnection.create({ data: { organizationId: org.organizationId, providerType: "GITHUB", status: "ACTIVE", externalScopeId: `g-${randomUUID()}`, name: "G2" } });
    for (const [to, ok] of [["DRAFT", false], ["TESTING", false], ["DISABLED", true], ["ACTIVE", true], ["QUARANTINED", true], ["ACTIVE", false],
      ["DISABLED", true], ["QUARANTINED", true], ["DISABLED", true]] as const) {
      const outcome = await settle(setStatus(org, live.id, to));
      if (ok) expect(outcome, to).toBe("ok"); else expect(text(outcome), to).toMatch(/PROVIDER_CONNECTION_STATUS_TRANSITION/);
    }
    expect(await owner.providerConnection.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ status: "DISABLED", statusChangedAt: expect.any(Date) });
    for (const to of ["DISABLED", "QUARANTINED"] as const)
      expect(text(await settle(setStatus(org, org.local, to)))).toMatch(/PROVIDER_CONNECTION_LOCAL_ALWAYS_ACTIVE/);
    expect(await statusOf(org.local)).toBe("ACTIVE");
  });

  it("kill switch: no session through a connection that is not ACTIVE; DISABLED keeps the open sessions (R5)", async () => {
    const org = await organization("pck");
    const open = await signIn(org, org.member, org.memberFederated);
    await setStatus(org, org.federated, "DISABLED");
    expect(reason(await settle(signIn(org, org.member, org.memberFederated)))).toBe("PROVIDER_CONNECTION_NOT_ACTIVE");
    expect(await settle(signIn(org, org.member, org.memberFederated))).toBeInstanceOf(SessionCreationDeniedError);
    // The database refuses it too, whatever the code path.
    expect(text(await settle(owner.session.create({ data: { id: sha(randomUUID()), ...scope(org), subjectId: org.member, identityAccountId: org.memberFederated, expiresAt: new Date(Date.now() + 3_600_000) } }))))
      .toMatch(/PROVIDER_CONNECTION_NOT_ACTIVE/);
    expect(await SessionStore.getSession(open.rawToken)).not.toBeNull();
    // LUXIA_LOCAL is unaffected: the same person signs in locally.
    expect((await signIn(org, org.admin, org.adminLocal)).session.revokedAt).toBeNull();
  });

  it("a quarantine that leaves an open session fails at commit and changes nothing", async () => {
    const org = await organization("pcq");
    const open = await signIn(org, org.member, org.memberFederated);
    expect(text(await settle(setStatus(org, org.federated, "QUARANTINED", { revoke: false })))).toMatch(/PROVIDER_CONNECTION_QUARANTINE_INCOMPLETE_SESSIONS/);
    expect(await statusOf(org.federated)).toBe("ACTIVE");
    expect(await isOpen(open.session.id)).toBe(true);
  });

  it("D3: the dry run counts; the quarantine revokes only that connection's sessions and deletes nothing; both are journaled", async () => {
    const org = await organization("pcd");
    const member = await signIn(org, org.member, org.memberFederated);
    const adminFederated = await signIn(org, org.admin, org.adminFederated);
    const adminLocal = await signIn(org, org.admin, org.adminLocal);
    const other = await signIn(b, b.member, b.memberFederated);
    const before = await authority(org);
    const plan = await planConnectionTransition(as(org), change(), org.federated, "QUARANTINE");
    expect(plan).toMatchObject({ providerConnectionId: org.federated, action: "QUARANTINE", from: "ACTIVE", to: "QUARANTINED", openSessions: 2, sessionsToRevoke: 2 });
    expect(await statusOf(org.federated)).toBe("ACTIVE");
    const result = await applyConnectionTransition(as(org), change(), org.federated, "QUARANTINE", plan.planDigest);
    expect(result).toMatchObject({ from: "ACTIVE", to: "QUARANTINED", revokedSessions: 2 });
    expect(await isOpen(member.session.id)).toBe(false);
    expect(await isOpen(adminFederated.session.id)).toBe(false);
    expect(await isOpen(adminLocal.session.id)).toBe(true);
    expect(await isOpen(other.session.id)).toBe(true);
    expect(await authority(org)).toEqual(before);
    const events = (await journal(org)).filter((event) => event.operation.startsWith("PROVIDER.CONNECTION."));
    expect(events.map((event) => [event.operation, event.result])).toEqual([["PROVIDER.CONNECTION.PLAN", "SUCCESS"], ["PROVIDER.CONNECTION.QUARANTINE", "SUCCESS"]]);
    expect(events[1].metadata).toMatchObject({ providerConnectionId: org.federated, from: "ACTIVE", to: "QUARANTINED", revokedSessions: 2, planDigest: plan.planDigest });
    expect(events[1].actorSubjectId).toBe(org.admin);
    // Release leaves it DISABLED: no sign-in until an explicit activation; then sign-in works again.
    await transition(org, org.federated, "RELEASE");
    expect(await statusOf(org.federated)).toBe("DISABLED");
    expect(reason(await settle(signIn(org, org.member, org.memberFederated)))).toBe("PROVIDER_CONNECTION_NOT_ACTIVE");
    await transition(org, org.federated, "ACTIVATE");
    expect((await signIn(org, org.member, org.memberFederated)).session.revokedAt).toBeNull();
    expect(await authority(org)).toEqual(before);
  });

  it("DISABLE keeps the open sessions (R5) and is reversible", async () => {
    const org = await organization("pcs");
    const open = await signIn(org, org.member, org.memberFederated);
    const { plan, result } = await transition(org, org.federated, "DISABLE");
    expect(plan.sessionsToRevoke).toBe(0);
    expect(result).toMatchObject({ from: "ACTIVE", to: "DISABLED", revokedSessions: 0 });
    expect(await isOpen(open.session.id)).toBe(true);
    await transition(org, org.federated, "ACTIVATE");
    expect(await statusOf(org.federated)).toBe("ACTIVE");
  });

  it("every refusal is journaled as DENIED and changes nothing: stale plan, LUXIA_LOCAL, transition, another organization, no permission", async () => {
    const org = await organization("pcr");
    const stale = await planConnectionTransition(as(org), change(), org.federated, "DISABLE");
    await transition(org, org.federated, "DISABLE");
    await transition(org, org.federated, "ACTIVATE");
    // Same status as when planned, but it changed in between: the digest binds the change time too.
    expect(reason(await settle(applyConnectionTransition(as(org), change(), org.federated, "DISABLE", stale.planDigest)))).toBe("CONNECTION_PLAN_STALE");
    expect(reason(await settle(planConnectionTransition(as(org), change(), org.local, "QUARANTINE")))).toBe("LOCAL_CONNECTION_PROTECTED");
    expect(reason(await settle(planConnectionTransition(as(org), change(), org.federated, "RELEASE")))).toBe("CONNECTION_TRANSITION_NOT_ALLOWED");
    // Another organization's connection does not exist for this administrator (RLS and tenant scope).
    expect(reason(await settle(planConnectionTransition(as(org), change(), b.federated, "QUARANTINE")))).toBe("PROVIDER_NOT_FOUND");
    expect(reason(await settle(applyConnectionTransition(as(org), change(), b.federated, "QUARANTINE", "0".repeat(64))))).toBe("PROVIDER_NOT_FOUND");
    // A member without providers.manage.
    expect(reason(await settle(planConnectionTransition(as(org, org.member), change(), org.federated, "DISABLE")))).toBe("FORBIDDEN");
    expect(await statusOf(org.federated)).toBe("ACTIVE");
    expect(await statusOf(b.federated)).toBe("ACTIVE");
    const denied = (await journal(org)).filter((event) => event.result === "DENIED").map((event) => [event.operation, (event.metadata as { reasonCode?: string }).reasonCode]);
    expect(denied).toEqual([
      ["PROVIDER.CONNECTION.DISABLE.DENIED", "CONNECTION_PLAN_STALE"],
      ["PROVIDER.CONNECTION.PLAN.DENIED", "LOCAL_CONNECTION_PROTECTED"],
      ["PROVIDER.CONNECTION.PLAN.DENIED", "CONNECTION_TRANSITION_NOT_ALLOWED"],
      ["PROVIDER.CONNECTION.PLAN.DENIED", "PROVIDER_NOT_FOUND"],
      ["PROVIDER.CONNECTION.QUARANTINE.DENIED", "PROVIDER_NOT_FOUND"],
      ["PROVIDER.CONNECTION.PLAN.DENIED", "FORBIDDEN"],
    ]);
    expect((await journal(b)).filter((event) => event.operation.startsWith("PROVIDER.CONNECTION."))).toEqual([]);
  });

  it("sign-in resolver: a connection that is not ACTIVE is no sign-in method; LUXIA_LOCAL stays", async () => {
    const org = await organization("pcl");
    expect((await resolveLoginOrganization(org.slug))?.federation.map((item) => item.id)).toEqual([org.federated]);
    await transition(org, org.federated, "DISABLE");
    expect(await resolveLoginOrganization(org.slug)).toMatchObject({ localConnectionId: org.local, federation: [] });
    const created = await createProviderConnection(as(org), { providerType: "MICROSOFT_ENTRA", externalScopeId: `new-${randomUUID()}`, name: "New" }, change());
    expect(created.status).toBe("DRAFT");
    expect(await resolveLoginOrganization(org.slug)).toMatchObject({ federation: [] });
  });

  it("race: quarantine first, a sign-in waits on the connection row and is refused", async () => {
    const org = await organization("pcx");
    const pause = gate(); const held = gate();
    const t = setStatus(org, org.federated, "QUARANTINED", { held: held.open, pause: pause.promise });
    await held.promise;
    const s = settle(signIn(org, org.member, org.memberFederated));
    try { await waitBlocked(1); } finally { pause.open(); }
    await t;
    expect(reason(await s)).toBe("PROVIDER_CONNECTION_NOT_ACTIVE");
  }, 60_000);

  it("race: sign-in first, the quarantine waits, then revokes the new session too", async () => {
    const org = await organization("pcy");
    const plan = await planConnectionTransition(as(org), change(), org.federated, "QUARANTINE");
    const pause = gate(); const held = gate();
    const id = sha(randomUUID());
    const s = withTenantDb(scope(org), async (tx) => {
      expect(await lockOrganizationActive(tx, org.organizationId)).toBe(true);
      expect(await lockProviderConnectionActive(tx, org.organizationId, org.memberFederated)).toBe(true);
      await tx.session.create({ data: { id, ...scope(org), subjectId: org.member, identityAccountId: org.memberFederated, expiresAt: new Date(Date.now() + 3_600_000) } });
      held.open(); await pause.promise;
    });
    await held.promise;
    const t = applyConnectionTransition(as(org), change(), org.federated, "QUARANTINE", plan.planDigest).then((value) => value, (error: unknown) => error);
    try { await waitBlocked(1); } finally { pause.open(); }
    await s;
    expect(await t).toMatchObject({ to: "QUARANTINED", revokedSessions: 1 });
    expect(await isOpen(id)).toBe(false);
  }, 60_000);
});
