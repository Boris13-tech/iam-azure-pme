import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { adminPrisma } from "../helpers/admin-prisma";

describe("Global Role Safety", () => {
  let roleId: string;
  let userId: string;

  beforeAll(async () => {
    // Admin creates role bypassing RLS/triggers
    const r = await adminPrisma.role.create({
      data: { name: "TestGlobalRole", description: "Global role test" }
    });
    roleId = r.id;

    const u = await adminPrisma.user.create({
      data: { email: "globaltest@example.com", name: "Global Test" }
    });
    userId = u.id;
  });

  afterAll(async () => {
    await adminPrisma.userRole.deleteMany({ where: { roleId } });
    await adminPrisma.user.deleteMany({ where: { id: userId } });
    await adminPrisma.role.deleteMany({ where: { id: roleId } });
  });

  it("should allow assigning a user to a global role", async () => {
    // Dual write membership is permitted
    const membership = await rawPrisma.userRole.create({
      data: { userId, roleId }
    });
    expect(membership.userId).toBe(userId);
  });

  it("should reject modifying a global role name", async () => {
    await expect(
      rawPrisma.role.update({
        where: { id: roleId },
        data: { name: "HackedName" }
      })
    ).rejects.toThrow(/Global role definitions are frozen/);
  });

  it("should reject deleting a global role", async () => {
    await expect(
      rawPrisma.role.delete({
        where: { id: roleId }
      })
    ).rejects.toThrow(/Global role definitions are frozen/);
  });
});
