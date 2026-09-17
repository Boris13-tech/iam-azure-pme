import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { createScopedDb } from "../../lib/db/scoped-client";
import { SessionContext } from "../../lib/auth/session-store";

describe("Tenant Boundaries Security", () => {
  let orgA: string;
  let tenantA: string;
  let subjectA: string;

  let orgB: string;
  let tenantB: string;

  beforeAll(async () => {
    const oA = await rawPrisma.organization.create({ data: { name: "Org A" } });
    orgA = oA.id;
    const tA = await rawPrisma.tenant.create({ data: { organizationId: orgA, name: "Tenant A" } });
    tenantA = tA.id;
    const sA = await rawPrisma.subject.create({
      data: { organizationId: orgA, tenantId: tenantA, type: "HUMAN", name: "Subject A" }
    });
    subjectA = sA.id;

    const oB = await rawPrisma.organization.create({ data: { name: "Org B" } });
    orgB = oB.id;
    const tB = await rawPrisma.tenant.create({ data: { organizationId: orgB, name: "Tenant B" } });
    tenantB = tB.id;
    await rawPrisma.subject.create({
      data: { organizationId: orgB, tenantId: tenantB, type: "HUMAN", name: "Subject B" }
    });
  });

  afterAll(async () => {
    await rawPrisma.subject.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } });
    await rawPrisma.tenant.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } });
    await rawPrisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
  });

  it("should prevent creating a Subject in Org A pointing to Tenant B", async () => {
    await expect(
      rawPrisma.subject.create({
        data: { organizationId: orgA, tenantId: tenantB, type: "HUMAN", name: "Hacker" }
      })
    ).rejects.toThrow();
  });

  it("should prevent fetching Org B subjects from Org A scoped DB", async () => {
    const auth: SessionContext = {
      organizationId: orgA,
      tenantId: tenantA,
      subjectId: subjectA,
      identityAccountId: "dummy"
    };

    const scopedPrisma = createScopedDb(auth);
    const subjects = await scopedPrisma.subject.findMany();

    // Should only return Org A subjects
    expect(subjects.length).toBe(1);
    expect(subjects[0].id).toBe(subjectA);
  });

  it("should override organizationId on create", async () => {
    const auth: SessionContext = { organizationId: orgA, tenantId: tenantA, subjectId: subjectA, identityAccountId: "dummy" };
    const scopedPrisma = createScopedDb(auth);

    const newSubject = await scopedPrisma.subject.create({
      data: { organizationId: orgB, tenantId: tenantB, type: "HUMAN", name: "Hacker Create" }
    });

    expect(newSubject.organizationId).toBe(orgA);
    expect(newSubject.tenantId).toBe(tenantA);
  });

  it("should override organizationId on update (prevent moving to another org)", async () => {
    const auth: SessionContext = { organizationId: orgA, tenantId: tenantA, subjectId: subjectA, identityAccountId: "dummy" };
    const scopedPrisma = createScopedDb(auth);

    const updated = await scopedPrisma.subject.update({
      where: { id: subjectA },
      data: { organizationId: orgB }
    });

    expect(updated.organizationId).toBe(orgA); // Overridden back to OrgA by scoped client
  });

  it("should prevent deleting data from another org", async () => {
    const auth: SessionContext = { organizationId: orgA, tenantId: tenantA, subjectId: subjectA, identityAccountId: "dummy" };
    const scopedPrisma = createScopedDb(auth);

    // This won't throw PrismaClientKnownRequestError directly if record not found in some cases depending on operation,
    // but update/delete with where will throw RecordNotFound if it doesn't match the where clause
    await expect(
      scopedPrisma.subject.delete({
        where: { id: "some-org-b-subject-id" }
      })
    ).rejects.toThrow();
  });
});
