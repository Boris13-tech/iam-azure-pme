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
    const oA = await adminPrisma.organization.create({ data: { name: "Org A" } });
    orgA = oA.id;
    const tA = await adminPrisma.tenant.create({ data: { organizationId: orgA, name: "Tenant A" } });
    tenantA = tA.id;
    const sA = await adminPrisma.subject.create({
      data: { organizationId: orgA, tenantId: tenantA, type: "HUMAN", name: "Subject A" }
    });
    subjectA = sA.id;

    const oB = await adminPrisma.organization.create({ data: { name: "Org B" } });
    orgB = oB.id;
    const tB = await adminPrisma.tenant.create({ data: { organizationId: orgB, name: "Tenant B" } });
    tenantB = tB.id;
    await adminPrisma.subject.create({
      data: { organizationId: orgB, tenantId: tenantB, type: "HUMAN", name: "Subject B" }
    });
  });

  afterAll(async () => {
    const orgIds = [orgA, orgB].filter((id): id is string => Boolean(id));
    if (orgIds.length > 0) {
      await adminPrisma.subject.deleteMany({ where: { organizationId: { in: orgIds } } });
      await adminPrisma.tenant.deleteMany({ where: { organizationId: { in: orgIds } } });
      await adminPrisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    }
  });

  it("should prevent creating a Subject in Org A pointing to Tenant B", async () => {
    await expect(
      adminPrisma.subject.create({
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

  it("should prevent creating a Subject with wrong organizationId", async () => {
    const auth: SessionContext = { organizationId: orgA, tenantId: tenantA, subjectId: subjectA, identityAccountId: "dummy" };
    const scopedPrisma = createScopedDb(auth);

    await expect(scopedPrisma.subject.create({
      data: { organizationId: orgB, tenantId: tenantB, type: "HUMAN", name: "Hacker Create" }
    })).rejects.toThrow("CROSS_ORGANIZATION_WRITE_DENIED");
  });

  it("should prevent updating organizationId (moving to another org)", async () => {
    const auth: SessionContext = { organizationId: orgA, tenantId: tenantA, subjectId: subjectA, identityAccountId: "dummy" };
    const scopedPrisma = createScopedDb(auth);

    await expect(scopedPrisma.subject.update({
      where: { id: subjectA },
      data: { organizationId: orgB }
    })).rejects.toThrow("CROSS_ORGANIZATION_WRITE_DENIED");
  });

  it("should prevent deleting data from another org", async () => {
    const auth: SessionContext = { organizationId: orgA, tenantId: tenantA, subjectId: subjectA, identityAccountId: "dummy" };
    const scopedPrisma = createScopedDb(auth);

    await expect(
      scopedPrisma.subject.delete({
        where: { id: "some-org-b-subject-id" }
      })
    ).rejects.toThrow();
  });

  describe("Composite Key Relational Boundaries", () => {
    it("Session with tenantA but Subject from tenantB should throw DB DENY", async () => {
      // Prisma itself shouldn't even allow this if composite fields are correct, but if bypassed, DB denies
      await expect(
        rawPrisma.session.create({
          data: {
            id: "fake-session",
            organizationId: orgA,
            tenantId: tenantA, 
            subjectId: "subject-from-tenant-b", // Mismatch
            identityAccountId: "dummy-id",
            expiresAt: new Date()
          }
        })
      ).rejects.toThrow();
    });

    it("Session with SubjectA but IdentityAccount from SubjectB should throw DB DENY", async () => {
      await expect(
        rawPrisma.session.create({
          data: {
            id: "fake-session-2",
            organizationId: orgA,
            tenantId: tenantA, 
            subjectId: subjectA, 
            identityAccountId: "identity-from-subject-b", // Mismatch
            expiresAt: new Date()
          }
        })
      ).rejects.toThrow();
    });

    it("IdentityAccount with tenantA but Subject from tenantB should throw DB DENY", async () => {
      await expect(
        adminPrisma.identityAccount.create({
          data: {
            id: "fake-identity",
            organizationId: orgA,
            tenantId: tenantA,
            subjectId: "subject-from-tenant-b", // Mismatch
            providerConnectionId: "dummy-provider",
            externalObjectId: "ext-oid"
          }
        })
      ).rejects.toThrow();
    });
  });
});
