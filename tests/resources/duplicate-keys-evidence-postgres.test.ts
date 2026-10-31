import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantDb } from "../../lib/db/scoped-client";
import { rawPrisma } from "../../lib/db/raw-prisma";
import * as governance from "../../lib/resources/service";

// Evidence for the duplicate-key refusal: which PostgreSQL role really runs it, and two creations that really overlap.
const auth = { organizationId: randomUUID(), tenantId: randomUUID(), subjectId: randomUUID() };
const context = { organizationId: auth.organizationId, tenantId: auth.tenantId };
const lockName = `resource-governance:${auth.organizationId}:${auth.tenantId}`;
let owner: PrismaClient;

describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("duplicate keys: role and forced overlap (PostgreSQL)", () => {
  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL! } } });
    await owner.organization.create({ data: { id: auth.organizationId, name: "Duplicate keys evidence" } });
    await owner.tenant.create({ data: { id: auth.tenantId, organizationId: auth.organizationId, name: "Duplicate keys evidence" } });
    await owner.subject.create({ data: { ...context, id: auth.subjectId, name: "Governance administrator", type: "HUMAN" } });
    for (const key of ["resources.read", "resources.manage"]) {
      const entitlement = await owner.entitlement.create({ data: { ...context, key, resource: key.split(".")[0], action: key.split(".")[1] } });
      await owner.assignment.create({ data: { ...context, subjectId: auth.subjectId, entitlementId: entitlement.id, source: "DIRECT" } });
    }
  }, 120_000);
  afterAll(async () => { await owner?.$disconnect(); await rawPrisma.$disconnect(); });

  it("the service runs as the runtime role, which is not superuser and does not bypass row-level security", async () => {
    const [role] = await withTenantDb(auth, (tx) => tx.$queryRaw<Array<{ who: string; superuser: boolean; bypass: boolean }>>`
      SELECT current_user::text AS who, r.rolsuper AS superuser, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user`);
    expect(role).toEqual({ who: "app_user", superuser: false, bypass: false });
    await governance.createScope(auth, { key: "role-proof", kind: "TENANT" }, `dup-evidence:${randomUUID()}`);
    // Row-level security really applies to that role: without the tenant context, the row is out of reach.
    expect(await rawPrisma.resourceScope.count({ where: { ...context, key: "role-proof" } })).toBe(0);
    expect(await withTenantDb(auth, (tx) => tx.resourceScope.count({ where: { ...context, key: "role-proof" } }))).toBe(1);
  });

  it("two creations held together at the governance lock: one SUCCESS, one journaled 409, never a 500", async () => {
    const ids = [`dup-evidence:${randomUUID()}`, `dup-evidence:${randomUUID()}`];
    let release!: () => void, held!: () => void;
    const releasing = new Promise<void>((resolve) => { release = resolve; });
    const isHeld = new Promise<void>((resolve) => { held = resolve; });
    // The owner takes the very lock the service takes, so both calls are in flight, each in its own transaction.
    const holder = owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockName}, 0))::text`;
      held();
      await releasing;
    }, { timeout: 60_000 });
    await isHeld;
    const creations = Promise.allSettled(ids.map((id) => governance.createScope(auth, { key: "overlap", kind: "TENANT" }, id)));
    const waiting = async () => {
      const [row] = await owner.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_locks l, (SELECT hashtextextended(${lockName}, 0) AS k) h
        WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
          AND l.classid::bigint = ((h.k >> 32) & 4294967295) AND l.objid::bigint = (h.k & 4294967295)`;
      return row.n;
    };
    let seen = 0;
    for (let i = 0; i < 200 && seen < 2; i++) { seen = await waiting(); if (seen < 2) await new Promise((resolve) => setTimeout(resolve, 50)); }
    expect(seen).toBe(2); // both really wait together: this is the overlap
    release();
    await holder;
    const results = await creations;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "SCOPE_KEY_TAKEN", httpStatus: 409 });
    expect(await withTenantDb(auth, (tx) => tx.resourceScope.count({ where: { ...context, key: "overlap" } }))).toBe(1);
    const rows = await withTenantDb(auth, (tx) => tx.canonicalAdminAuditEvent.findMany({ where: { ...context, changeId: { in: ids } } }));
    expect(rows.map((row) => row.result).sort()).toEqual(["DENIED", "SUCCESS"]);
  }, 60_000);
});
