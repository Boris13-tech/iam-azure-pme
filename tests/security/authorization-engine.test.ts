import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authorize, AuthorizationInfrastructureError, AuthContext } from "../../lib/auth/authorization-engine";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";

// Mock database wrapper to avoid full PostgreSQL spin-up just for engine logic
vi.mock("../../lib/db/scoped-client", () => ({
  withTenantDb: vi.fn(),
}));

describe("Phase 5C - Native Authorization Engine", () => {
  const auth: AuthContext = {
    organizationId: "org-1",
    tenantId: "tenant-1",
    subjectId: "subj-1",
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("unknown action/resource -> DENY_UNKNOWN_ENTITLEMENT", async () => {
    const decision = await authorize(auth, { action: "fly", resource: "moon" });
    
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("DENY_UNKNOWN_ENTITLEMENT");
    expect(withTenantDb).not.toHaveBeenCalled();
  });

  it("invalid context -> DENY_INVALID_CONTEXT", async () => {
    const invalidAuth = { ...auth, subjectId: "" };
    const decision = await authorize(invalidAuth, { action: "read", resource: "users" });
    
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("DENY_INVALID_CONTEXT");
    expect(withTenantDb).not.toHaveBeenCalled();
  });

  it("database/RLS failure -> AuthorizationInfrastructureError -> never ALLOW", async () => {
    vi.mocked(withTenantDb).mockRejectedValueOnce(new Error("DB Down"));
    
    await expect(
      authorize(auth, { action: "read", resource: "users" })
    ).rejects.toThrow(AuthorizationInfrastructureError);
  });

  it("no assignment -> DENY_NO_ACTIVE_ASSIGNMENT", async () => {
    vi.mocked(withTenantDb).mockImplementationOnce(async (scope, cb) => {
      // Mock the tx object
      await cb({
        assignment: {
          findMany: vi.fn().mockResolvedValue([]),
        }
      } as any);
    });

    const decision = await authorize(auth, { action: "read", resource: "users" });
    
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("DENY_NO_ACTIVE_ASSIGNMENT");
  });

  it("ACTIVE assignment -> ALLOW_ACTIVE_ASSIGNMENT", async () => {
    vi.mocked(withTenantDb).mockImplementationOnce(async (scope, cb) => {
      await cb({
        assignment: {
          findMany: vi.fn().mockResolvedValue([
            { id: "assign-1", entitlementId: "ent-1", status: "ACTIVE" }
          ]),
        }
      } as any);
    });

    const decision = await authorize(auth, { action: "read", resource: "users" });
    
    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe("ALLOW_ACTIVE_ASSIGNMENT");
    expect(decision.matchedAssignmentIds).toEqual(["assign-1"]);
    expect(decision.matchedEntitlementIds).toEqual(["ent-1"]);
  });

  it("multiple grants + at least one effective -> ALLOW", async () => {
    vi.mocked(withTenantDb).mockImplementationOnce(async (scope, cb) => {
      await cb({
        assignment: {
          findMany: vi.fn().mockResolvedValue([
            { id: "assign-1", entitlementId: "ent-1", status: "ACTIVE" }, // Legacy role
            { id: "assign-2", entitlementId: "ent-1", status: "ACTIVE" }  // Direct grant
          ]),
        }
      } as any);
    });

    const decision = await authorize(auth, { action: "read", resource: "users" });
    
    expect(decision.allowed).toBe(true);
    expect(decision.matchedAssignmentIds).toHaveLength(2);
    // Should deduplicate entitlement IDs
    expect(decision.matchedEntitlementIds).toEqual(["ent-1"]);
  });
});
