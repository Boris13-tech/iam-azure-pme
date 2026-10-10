// Canonical audit journal list: tenant isolation (RLS), read filtering, display names, and the
// consultation itself being audited. app_user PostgreSQL.
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { listCanonicalAdminAudit } from "../../lib/admin/canonical-administration";

const org = randomUUID(), tenantA = randomUUID(), tenantB = randomUUID();
const A = { organizationId: org, tenantId: tenantA }, B = { organizationId: org, tenantId: tenantB };
const actor = randomUUID(), target = randomUUID(), actorB = randomUUID();
let owner: PrismaClient;
const change = () => `read:audit:${randomUUID()}`;

describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("canonical audit journal list (app_user PostgreSQL/RLS)", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!(["localhost", "127.0.0.1"].includes(url.hostname) || (url.hostname === "ep-weathered-grass-ah5vrehj-pooler.c-3.us-east-1.aws.neon.tech" && ["/luxia_resources_diag_ci05"].includes(url.pathname)))) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL! } } });
    await owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${org}, true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      await tx.organization.create({ data: { id: org, name: "Audit list fixture" } });
      for (const id of [tenantA, tenantB]) await tx.tenant.create({ data: { id, organizationId: org, name: "Audit list fixture" } });
      await tx.subject.create({ data: { ...A, id: actor, name: "Admin A", type: "HUMAN" } });
      await tx.subject.create({ data: { ...A, id: target, name: "Target A", type: "HUMAN" } });
      const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
      for (const [operation, result, minutes, t] of [["SESSION.REVOKE", "SUCCESS", 5, target], ["SUBJECT.READ", "SUCCESS", 4, null],
        ["AUTHORIZATION.DENIED", "DENIED", 3, null]] as const)
        await tx.canonicalAdminAuditEvent.create({ data: { ...A, actorSubjectId: actor, targetSubjectId: t, operation, result,
          changeId: `fixture:${randomUUID()}`, occurredAt: at(minutes) } });
    });
    await owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${org}, true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
      await tx.subject.create({ data: { ...B, id: actorB, name: "Admin B", type: "HUMAN" } });
      await tx.canonicalAdminAuditEvent.create({ data: { ...B, actorSubjectId: actorB, operation: "SESSION.REVOKE", result: "SUCCESS", changeId: `fixture:${randomUUID()}` } });
    });
  }, 120_000);
  afterAll(async () => { await owner?.$disconnect(); await rawPrisma.$disconnect(); });

  it("excludes consultations on request, returns only this tenant, newest first, with display names", async () => {
    const rows = await listCanonicalAdminAudit({ ...A, subjectId: actor }, { take: 50, excludeReads: true, changeId: change() });
    expect(rows.map(r => r.operation)).toEqual(["AUTHORIZATION.DENIED", "SESSION.REVOKE"]);
    expect(rows.every(r => r.tenantId === tenantA)).toBe(true);
    expect(rows[1].actor?.name).toBe("Admin A");
    expect(rows[1].target?.name).toBe("Target A");
    expect(rows[0].target).toBeNull();
  });

  it("includes consultations when asked, and the consultation itself is audited", async () => {
    const changeId = change();
    const rows = await listCanonicalAdminAudit({ ...A, subjectId: actor }, { take: 50, changeId });
    expect(rows[0]).toMatchObject({ operation: "AUDIT.READ", changeId, result: "SUCCESS" });
    expect(rows.map(r => r.operation)).toContain("SUBJECT.READ");
    expect(rows.some(r => r.actorSubjectId === actorB)).toBe(false);
  });

  it("tenant B sees only its own journal", async () => {
    const rows = await listCanonicalAdminAudit({ ...B, subjectId: actorB }, { take: 50, excludeReads: true, changeId: change() });
    expect(rows.map(r => r.actor?.name)).toEqual(["Admin B"]);
    expect(await withTenantDb(B, tx => tx.canonicalAdminAuditEvent.count({ where: { actorSubjectId: actor } }))).toBe(0);
  });
});
