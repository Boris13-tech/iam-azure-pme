import { randomUUID } from "node:crypto";
import { PrismaClient, type SubjectLifecycleState } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { disableIdentityAccount, grantAssignment, revokeAssignment, updateSubject } from "../../lib/admin/canonical-administration";
import {
  countDurableAdministrators, durableAdministratorWhere, LAST_ADMINISTRATOR_PROTECTED, lockTenantGovernance, preserveLastAdministrator,
} from "../../lib/admin/last-administrator";
import * as governance from "../../lib/resources/service";
import { applyGovernanceAdminBundle, rollbackGovernanceAdminBundle } from "../../lib/resources/admin-bundle";
import { getOnboardingChecklist } from "../../lib/onboarding/checklist";
import { beginAcceptance, completeAcceptance, createInvitation, revokeInvitation } from "../../lib/onboarding/invitations";
import { softwarePasskey } from "../helpers/software-passkey";

// First Admin / Break-glass v1, B1, on PostgreSQL as app_user: no change, alone or concurrent, may take a
// tenant from at least one durable administrator to none. Refusals are audited and leave no partial
// change behind, and the guard shares one lock order with every other governance writer (no deadlock).
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const suffix = randomUUID().slice(0, 8);
const change = () => `test:${randomUUID()}`;
const day = 86_400_000;
let owner: PrismaClient;
let orgs = 0;

type Org = { organizationId: string; tenantId: string; connectionId: string; manage: string; read: string; create: string };
type Grant = "permanent" | "temporary" | "future" | "expired" | "legacy" | "none";
type Person = { id: string; account: string; session: string; admin: string | null; read: string };

const scope = (org: Org) => ({ organizationId: org.organizationId, tenantId: org.tenantId });
const as = (org: Org, subjectId: string) => ({ ...scope(org), subjectId });
const administrators = (org: Org) => owner.subject.count({ where: durableAdministratorWhere(scope(org), new Date()) });

async function organization(): Promise<Org> {
  const organizationId = randomUUID(), tenantId = randomUUID();
  await owner.organization.create({ data: { id: organizationId, name: "Last Admin", slug: `la-${suffix}-${++orgs}` } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const connection = await owner.providerConnection.create({ data: { organizationId, providerType: "LUXIA_LOCAL", externalScopeId: tenantId, name: "LUXIA Local" } });
  await owner.providerConnectionTenantScope.create({ data: { organizationId, tenantId, providerConnectionId: connection.id } });
  const entitlement = (key: string) => owner.entitlement.create({ data: { organizationId, tenantId, key, resource: key.split(".")[0], action: key.split(".")[1] } });
  const [manage, read, create] = [await entitlement("assignments.manage"), await entitlement("subjects.read"), await entitlement("subjects.create")];
  return { organizationId, tenantId, connectionId: connection.id, manage: manage.id, read: read.id, create: create.id };
}

async function person(org: Org, name: string, grant: Grant, options: { account?: "ACTIVE" | "DISABLED"; type?: "HUMAN" | "SERVICE" } = {}): Promise<Person> {
  const subject = await owner.subject.create({ data: { ...scope(org), type: options.type ?? "HUMAN", name, lifecycleState: "ACTIVE" } });
  const status = options.account ?? "ACTIVE";
  const account = await owner.identityAccount.create({ data: { ...scope(org), subjectId: subject.id, providerConnectionId: org.connectionId,
    externalObjectId: randomUUID(), status, disabledAt: status === "DISABLED" ? new Date() : null } });
  const session = await owner.session.create({ data: { id: randomUUID(), ...scope(org), subjectId: subject.id, identityAccountId: account.id,
    expiresAt: new Date(Date.now() + 3_600_000) } });
  const read = await owner.assignment.create({ data: { ...scope(org), subjectId: subject.id, entitlementId: org.read, source: "DIRECT", sourceRef: "test" } });
  const shape = { permanent: {}, temporary: { validUntil: new Date(Date.now() + 7 * day) }, future: { validFrom: new Date(Date.now() + day) },
    expired: { validFrom: new Date(Date.now() - 2 * day), validUntil: new Date(Date.now() - day) },
    legacy: { source: "LEGACY_ROLE" as const, sourceRef: "legacy-role" } }[grant as Exclude<Grant, "none">];
  const admin = grant === "none" ? null : await owner.assignment.create({ data: { ...scope(org), subjectId: subject.id, entitlementId: org.manage,
    source: "DIRECT", sourceRef: "test", ...shape } });
  return { id: subject.id, account: account.id, session: session.id, admin: admin?.id ?? null, read: read.id };
}

const refused = { code: LAST_ADMINISTRATOR_PROTECTED, httpStatus: 409 };
const denials = (org: Org) => owner.canonicalAdminAuditEvent.findMany({ where: { ...scope(org), result: "DENIED" }, orderBy: { occurredAt: "asc" } });

async function unchanged(target: Person, lifecycleVersion: number) {
  const subject = await owner.subject.findUniqueOrThrow({ where: { id: target.id } });
  expect(subject).toMatchObject({ lifecycleState: "ACTIVE", lifecycleVersion });
  expect(await owner.identityAccount.findUniqueOrThrow({ where: { id: target.account } })).toMatchObject({ status: "ACTIVE", disabledAt: null });
  expect((await owner.session.findUniqueOrThrow({ where: { id: target.session } })).revokedAt).toBeNull();
  const grants = await owner.assignment.findMany({ where: { subjectId: target.id } });
  expect(grants.every(grant => grant.status === "ACTIVE" && grant.validUntil === null)).toBe(true);
}

/**
 * Holds the tenant lock (from the owner pool, so every application connection stays free for the
 * operations), waits until all operations are queued on it in pg_locks, then releases it.
 */
async function race(org: Org, operations: Array<() => Promise<unknown>>) {
  let release!: () => void, held!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { held = resolve; });
  const holder = owner.$transaction(async tx => { await lockTenantGovernance(tx, scope(org)); held(); await gate; }, { timeout: 60_000 });
  await ready;
  const settled = operations.map(operation => operation().then(() => "ok" as const, (error: unknown) => error));
  for (let attempt = 0; ; attempt++) {
    const [{ waiting }] = await owner.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    if (waiting >= operations.length) break;
    if (attempt > 400) throw new Error("OPERATIONS_NOT_QUEUED_ON_LOCK");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  release();
  await holder;
  return Promise.all(settled);
}
/** Errors other than the expected business refusals (a deadlock would show up here). */
const unexpected = (results: unknown[], allowed: string[]) => results.filter(result => result !== "ok")
  .filter(error => !allowed.includes((error as { code?: string }).code ?? "")).map(String);
const rotate = <T>(items: T[], by: number) => [...items.slice(by), ...items.slice(0, by)];

/** Two administrators, a member with a resource grant, and an ADMIN invitation ready to be accepted. */
async function mixedOrganization() {
  const org = await organization();
  const a = await person(org, "Admin A", "permanent");
  const b = await person(org, "Admin B", "permanent");
  const member = await person(org, "Member", "none");
  for (const admin of [a, b]) await owner.assignment.create({ data: { ...scope(org), subjectId: admin.id, entitlementId: org.create, source: "DIRECT", sourceRef: "test" } });
  const resource = await owner.resource.create({ data: { ...scope(org), name: "Application", type: "APPLICATION" } });
  const resourceScope = await owner.resourceScope.create({ data: { ...scope(org), key: `app-${randomUUID().slice(0, 8)}`, kind: "RESOURCE", resourceId: resource.id } });
  const entitlement = await owner.entitlement.create({ data: { ...scope(org), key: `resource-scope:${resourceScope.id}:read`, resource: "resource-scope",
    action: "read", resourceScopeId: resourceScope.id } });
  const resourceGrant = await owner.assignment.create({ data: { ...scope(org), subjectId: member.id, entitlementId: entitlement.id, source: "DIRECT",
    validUntil: new Date(Date.now() + day) } });
  const invited = await createInvitation(as(org, a.id), change(), { name: "Invited Admin", role: "ADMIN" });
  const principalName = `invited-${randomUUID().slice(0, 8)}`;
  const passkey = softwarePasskey();
  const begin = await beginAcceptance({ token: invited.token, principalName }, "localhost");
  const accept = () => completeAcceptance({ token: invited.token, principalName, ...passkey.register(begin.challenge) },
    { rpId: "localhost", origin: "http://localhost:3000" });
  return { org, a, b, member, resourceGrant: resourceGrant.id, invitationId: invited.invitation.id, accept };
}

describe.runIf(enabled)("B1 last-administrator guard (app_user, PostgreSQL)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
  });
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("refuses every direct removal of the only durable administrator, audits it and changes nothing", async () => {
    const org = await organization();
    const admin = await person(org, "Admin", "permanent");
    const operator = await person(org, "Operator", "none"); // may hold subjects.update etc., but is not an administrator
    const member = await person(org, "Member", "none");
    const version = (await owner.subject.findUniqueOrThrow({ where: { id: admin.id } })).lifecycleVersion;
    expect(await administrators(org)).toBe(1);

    await expect(disableIdentityAccount(as(org, operator.id), admin.account, change())).rejects.toMatchObject(refused);
    const states: SubjectLifecycleState[] = ["SUSPENDED", "DISABLED", "RECOVERY_REQUIRED", "RETIRED"];
    for (const lifecycleState of states)
      await expect(updateSubject(as(org, operator.id), admin.id, { lifecycleState }, change())).rejects.toMatchObject(refused);
    await expect(revokeAssignment(as(org, operator.id), admin.admin!, change())).rejects.toMatchObject(refused);
    await unchanged(admin, version);
    expect(await administrators(org)).toBe(1);

    const denied = await denials(org);
    expect(denied.map(event => event.operation)).toEqual([
      "IDENTITY_ACCOUNT.DISABLE.DENIED", ...states.map(() => "SUBJECT.UPDATE.DENIED"), "ASSIGNMENT.REVOKE.DENIED",
    ]);
    for (const event of denied) {
      expect(event).toMatchObject({ actorSubjectId: operator.id, targetSubjectId: admin.id, metadata: { reasonCode: LAST_ADMINISTRATOR_PROTECTED } });
    }
    expect(await owner.canonicalAdminAuditEvent.count({ where: { ...scope(org), result: "SUCCESS" } })).toBe(0);

    // Changes that keep the administrator are not blocked.
    await expect(updateSubject(as(org, operator.id), admin.id, { name: "Admin renamed" }, change())).resolves.toMatchObject({ lifecycleState: "ACTIVE" });
    await expect(revokeAssignment(as(org, operator.id), admin.read, change())).resolves.toMatchObject({ status: "REVOKED" });
    await expect(disableIdentityAccount(as(org, operator.id), member.account, change())).resolves.toMatchObject({ status: "DISABLED" });
    await expect(updateSubject(as(org, operator.id), member.id, { lifecycleState: "SUSPENDED" }, change())).resolves.toMatchObject({ lifecycleState: "SUSPENDED" });
    expect(await administrators(org)).toBe(1);
  });

  it("lets one of two durable administrators go, never the last one", async () => {
    const org = await organization();
    const a = await person(org, "Admin A", "permanent");
    const b = await person(org, "Admin B", "permanent");
    const operator = await person(org, "Operator", "none");
    expect(await administrators(org)).toBe(2);
    await expect(disableIdentityAccount(as(org, a.id), b.account, change())).resolves.toMatchObject({ status: "DISABLED" });
    expect(await administrators(org)).toBe(1); // B keeps its grant but can no longer sign in
    await expect(updateSubject(as(org, operator.id), a.id, { lifecycleState: "SUSPENDED" }, change())).rejects.toMatchObject(refused);
    await expect(revokeAssignment(as(org, b.id), a.admin!, change())).rejects.toMatchObject(refused);
    expect(await administrators(org)).toBe(1);
  });

  it("counts only durable administrators: permanent, native, effective grant, active human with an active account", async () => {
    const org = await organization();
    const admin = await person(org, "Admin", "permanent");
    const operator = await person(org, "Operator", "none");
    await person(org, "Temporary", "temporary");
    await person(org, "Future", "future");
    await person(org, "Expired", "expired");
    await person(org, "Legacy", "legacy");
    await person(org, "No account", "permanent", { account: "DISABLED" });
    await person(org, "Service", "permanent", { type: "SERVICE" });
    expect(await administrators(org)).toBe(1);
    expect(await withTenantDb(scope(org), tx => countDurableAdministrators(tx, scope(org)))).toBe(1); // same count as app_user under RLS
    await expect(updateSubject(as(org, operator.id), admin.id, { lifecycleState: "DISABLED" }, change())).rejects.toMatchObject(refused);

    // "Second administrator" in the checklist means a second durable administrator who can sign in.
    expect(await getOnboardingChecklist(as(org, operator.id), change())).toMatchObject({ secondAdministrator: false });
    await person(org, "Second admin", "permanent");
    expect(await getOnboardingChecklist(as(org, operator.id), change())).toMatchObject({ secondAdministrator: true });
  });

  it("only the subject's own account, in the same tenant, makes it count", async () => {
    const org = await organization();
    const admin = await person(org, "Admin", "permanent");
    await person(org, "Granted, own account disabled", "permanent", { account: "DISABLED" }); // other people's active accounts do not help
    const otherTenant = randomUUID();
    await owner.tenant.create({ data: { id: otherTenant, organizationId: org.organizationId, name: "Other tenant" } });
    // The account relation is (organization, tenant, subject): an account of another tenant cannot point at this subject.
    await expect(owner.identityAccount.create({ data: { organizationId: org.organizationId, tenantId: otherTenant, subjectId: admin.id,
      providerConnectionId: org.connectionId, externalObjectId: randomUUID() } })).rejects.toMatchObject({ code: "P2003" });
    expect(await administrators(org)).toBe(1);
    const other = { organizationId: org.organizationId, tenantId: otherTenant };
    expect(await withTenantDb(other, tx => countDurableAdministrators(tx, other))).toBe(0);
  });

  it("does not freeze a tenant already without a durable administrator, which can be repaired and is then protected", async () => {
    const org = await organization();
    const operator = await person(org, "Operator", "none");
    const member = await person(org, "Member", "temporary");
    const heir = await person(org, "Heir", "none");
    expect(await administrators(org)).toBe(0);
    await expect(disableIdentityAccount(as(org, operator.id), member.account, change())).resolves.toMatchObject({ status: "DISABLED" });
    await expect(updateSubject(as(org, operator.id), member.id, { lifecycleState: "SUSPENDED" }, change())).resolves.toMatchObject({ lifecycleState: "SUSPENDED" });
    await expect(grantAssignment(as(org, operator.id), { subjectId: heir.id, entitlementId: org.manage }, change())).resolves.toMatchObject({ status: "ACTIVE" });
    expect(await administrators(org)).toBe(1);
    await expect(updateSubject(as(org, operator.id), heir.id, { lifecycleState: "SUSPENDED" }, change())).rejects.toMatchObject(refused);
  });

  it("serializes concurrent removals: two administrators removing each other leave exactly one", async () => {
    const scenarios: Array<[string, (org: Org, a: Person, b: Person) => Array<() => Promise<unknown>>]> = [
      ["account vs account", (org, a, b) => [() => disableIdentityAccount(as(org, a.id), b.account, change()), () => disableIdentityAccount(as(org, b.id), a.account, change())]],
      ["suspend vs suspend", (org, a, b) => [() => updateSubject(as(org, a.id), b.id, { lifecycleState: "SUSPENDED" }, change()), () => updateSubject(as(org, b.id), a.id, { lifecycleState: "SUSPENDED" }, change())]],
      ["grant vs grant", (org, a, b) => [() => revokeAssignment(as(org, a.id), b.admin!, change()), () => revokeAssignment(as(org, b.id), a.admin!, change())]],
      ["account vs retire", (org, a, b) => [() => disableIdentityAccount(as(org, a.id), b.account, change()), () => updateSubject(as(org, b.id), a.id, { lifecycleState: "RETIRED" }, change())]],
    ];
    for (const [name, operations] of scenarios) {
      const org = await organization();
      const a = await person(org, "Admin A", "permanent");
      const b = await person(org, "Admin B", "permanent");
      const results = await race(org, operations(org, a, b));
      expect(results.filter(result => result === "ok"), name).toHaveLength(1);
      expect(results.filter(result => result !== "ok"), name).toEqual([expect.objectContaining(refused)]);
      expect(await administrators(org), name).toBe(1);
      expect((await denials(org)).map(event => (event.metadata as { reasonCode: string }).reasonCode), name).toEqual([LAST_ADMINISTRATOR_PROTECTED]);
    }
  }, 120_000);

  it("serializes three concurrent removals by a non-administrator: two pass, the last one is refused", async () => {
    const org = await organization();
    const admins = [await person(org, "A", "permanent"), await person(org, "B", "permanent"), await person(org, "C", "permanent")];
    const operator = await person(org, "Operator", "none");
    const results = await race(org, admins.map(admin => () => disableIdentityAccount(as(org, operator.id), admin.account, change())));
    expect(results.filter(result => result === "ok")).toHaveLength(2);
    expect(results.filter(result => result !== "ok")).toEqual([expect.objectContaining(refused)]);
    expect(await administrators(org)).toBe(1);
  }, 60_000);

  it("never deadlocks with resource governance or invitations: administrator removals mixed with a resource revoke", async () => {
    for (const by of [0, 2]) {
      const { org, a, b, member, resourceGrant } = await mixedOrganization();
      const results = await race(org, rotate([
        () => revokeAssignment(as(org, a.id), b.admin!, change()),
        () => revokeAssignment(as(org, b.id), a.admin!, change()),
        () => governance.revokeAssignment(as(org, a.id), resourceGrant, change()),
        () => disableIdentityAccount(as(org, b.id), member.account, change()),
      ], by));
      expect(unexpected(results, [LAST_ADMINISTRATOR_PROTECTED, "FORBIDDEN"]), `rotation ${by}`).toEqual([]);
      expect(results.filter(result => (result as { code?: string }).code === LAST_ADMINISTRATOR_PROTECTED), `rotation ${by}`).toHaveLength(1);
      expect(await administrators(org), `rotation ${by}`).toBe(1);
    }
  }, 120_000);

  it("never deadlocks with resource governance or invitations: ADMIN acceptance, invitation revoke, suspension, resource revoke", async () => {
    for (const by of [0, 2]) {
      const { org, a, b, resourceGrant, invitationId, accept } = await mixedOrganization();
      const results = await race(org, rotate([
        accept,
        () => revokeInvitation(as(org, b.id), change(), invitationId),
        () => updateSubject(as(org, b.id), a.id, { lifecycleState: "SUSPENDED" }, change()),
        () => governance.revokeAssignment(as(org, a.id), resourceGrant, change()),
      ], by));
      expect(unexpected(results, ["INVITATION_INVALID", "INVITATION_NOT_OPEN", "FORBIDDEN"]), `rotation ${by}`).toEqual([]);
      const invitation = await owner.invitation.findUniqueOrThrow({ where: { id: invitationId } });
      expect(invitation.acceptedAt !== null && invitation.revokedAt !== null, `rotation ${by}`).toBe(false); // accepted or revoked, never both
      expect([results[(4 - by) % 4], results[(5 - by) % 4]].filter(result => result === "ok").length, `rotation ${by}`).toBeLessThanOrEqual(1);
      expect(await administrators(org), `rotation ${by}`).toBeGreaterThanOrEqual(1);
    }
  }, 120_000);

  it("resource governance and the v2 bundle cannot reach administrator authority", async () => {
    const org = await organization();
    const a = await person(org, "Admin A", "permanent");
    const b = await person(org, "Admin B", "permanent");
    await expect(governance.revokeAssignment(as(org, a.id), b.admin!, change())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(governance.updateAssignment(as(org, a.id), b.admin!, { status: "REVOKED" }, change())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await applyGovernanceAdminBundle(as(org, a.id), b.id, change());
    await rollbackGovernanceAdminBundle(as(org, a.id), b.id, change());
    expect(await owner.assignment.findUniqueOrThrow({ where: { id: b.admin! } })).toMatchObject({ status: "ACTIVE" });
    expect(await administrators(org)).toBe(2);
  });

  it("rolls a refused change back to its savepoint and keeps the rest of the transaction", async () => {
    const org = await organization();
    const admin = await person(org, "Admin", "permanent");
    const member = await person(org, "Member", "none");
    const outcome = await withTenantDb(scope(org), async tx => {
      const error = await preserveLastAdministrator(tx, scope(org), () =>
        tx.assignment.update({ where: { id: admin.admin! }, data: { status: "REVOKED" } })).catch((caught: unknown) => caught);
      await tx.subject.update({ where: { id: member.id }, data: { name: "Written after the refusal" } });
      return error;
    });
    expect(outcome).toMatchObject(refused);
    expect(await owner.assignment.findUniqueOrThrow({ where: { id: admin.admin! } })).toMatchObject({ status: "ACTIVE" });
    expect(await owner.subject.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({ name: "Written after the refusal" });
  });
});
