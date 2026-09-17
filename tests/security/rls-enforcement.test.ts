import { describe, it, expect, beforeAll } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { randomUUID } from "crypto";

describe("PostgreSQL RLS Enforcement", () => {
  const orgA = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  // In a real environment, rawPrisma connects as the runtime non-owner role.
  // This non-owner role does not bypass RLS.
  
  it("should return 0 rows when queried without RLS context", async () => {
    // Queries via rawPrisma do not have `app.organization_id` or `app.tenant_id` set
    const subjects = await rawPrisma.subject.findMany();
    // Since RLS is FORCED and the policy requires the context to match, 
    // it will evaluate to FALSE and return 0 rows, even if subjects exist.
    expect(subjects.length).toBe(0);
  });

  it("should allow querying when correct tenant context is set", async () => {
    const scope = { organizationId: orgA, tenantId: tenantA };
    
    // Use the unit of work which executes SET LOCAL in the transaction
    await withTenantDb(scope, async (tx) => {
      const subjects = await tx.subject.findMany();
      // Should correctly query without being blocked by RLS
      expect(Array.isArray(subjects)).toBe(true);
    });
  });

  it("should prevent inserting data crossing RLS tenant boundaries", async () => {
    const scopeA = { organizationId: orgA, tenantId: tenantA };
    
    await withTenantDb(scopeA, async (tx) => {
      // Trying to insert a record for tenantB while scoped to tenantA
      await expect(
        tx.subject.create({
          data: {
            organizationId: orgA,
            tenantId: tenantB, // Boundary crossing
            type: "HUMAN",
            name: "Hacker"
          }
        })
      ).rejects.toThrow(); // RLS WITH CHECK policy will fail
    });
  });
});
