import { describe, it, expect, vi } from "vitest";
import { runLegacyRbacBackfill } from "../../lib/auth/backfill-service";
import { rawPrisma } from "../../lib/db/raw-prisma";

// Mock the rawPrisma dependency
vi.mock("../../lib/db/raw-prisma", () => ({
  rawPrisma: {
    subject: {
      findMany: vi.fn(),
    }
  }
}));

describe("Phase 5B - Legacy RBAC Backfill Pipeline", () => {
  const org = "org-1";
  const tenant = "tenant-1";

  it("should return empty report when no validated bridges exist", async () => {
    vi.mocked(rawPrisma.subject.findMany).mockResolvedValueOnce([]);
    
    const report = await runLegacyRbacBackfill({
      organizationId: org,
      tenantId: tenant,
      mode: "dry-run"
    });

    expect(report.metrics.validatedBridges).toBe(0);
    expect(report.metrics.assignmentsToCreate).toBe(0);
  });

  it("should fail closed if unmapped legacy permissions exist", async () => {
    // Mock a subject with an unknown legacy permission
    vi.mocked(rawPrisma.subject.findMany).mockResolvedValueOnce([
      {
        id: "subj-1",
        organizationId: org,
        tenantId: tenant,
        legacyBridge: {
          status: "VALIDATED",
          legacyUser: {
            id: "user-1",
            roles: [
              {
                role: {
                  id: "role-1",
                  name: "Editor",
                  permissions: [
                    {
                      permission: {
                        action: "dance",
                        resource: "macarena"
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
      }
    ] as any);

    await expect(
      runLegacyRbacBackfill({
        organizationId: org,
        tenantId: tenant,
        mode: "dry-run"
      })
    ).rejects.toThrow(/1 unmapped permissions discovered/);
  });

  it("should expand Administrateur role properly", async () => {
    vi.mocked(rawPrisma.subject.findMany).mockResolvedValueOnce([
      {
        id: "subj-admin",
        organizationId: org,
        tenantId: tenant,
        legacyBridge: {
          status: "VALIDATED",
          legacyUser: {
            id: "user-admin",
            roles: [
              {
                role: {
                  id: "role-admin",
                  name: "Administrateur",
                  permissions: [] // even if empty, it should expand
                }
              }
            ]
          }
        }
      }
    ] as any);

    const report = await runLegacyRbacBackfill({
      organizationId: org,
      tenantId: tenant,
      mode: "dry-run"
    });

    expect(report.metrics.administrateurExpansions).toBe(1);
    expect(report.metrics.entitlementsToCreate).toBeGreaterThan(5); // The V1 catalog has 11
    expect(report.metrics.assignmentsToCreate).toBe(report.metrics.entitlementsToCreate);
    expect(report.metrics.unmappedPermissions).toBe(0);
  });
});
