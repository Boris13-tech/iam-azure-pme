import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkPermission } from "../../lib/auth/authorization-gateway";
import { hasLegacyPermission } from "../../lib/auth/legacy-auth-adapter";
import { authorize } from "../../lib/auth/authorization-engine";
import { withTenantDb } from "../../lib/db/scoped-client";

vi.mock("../../lib/auth/legacy-auth-adapter", () => ({
  hasLegacyPermission: vi.fn(),
}));

vi.mock("../../lib/auth/authorization-engine", () => ({
  authorize: vi.fn(),
  AuthorizationInfrastructureError: class AuthorizationInfrastructureError extends Error {},
}));

vi.mock("../../lib/db/scoped-client", () => ({
  withTenantDb: vi.fn(),
}));

describe("Phase 5D - Authorization Shadow Parity Mode", () => {
  const auth = {
    organizationId: "org-1",
    tenantId: "tenant-1",
    subjectId: "subj-1",
  };

  const req = { action: "read", resource: "users" };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTHZ_MODE = "shadow";
    // Mock the async observation creation so we can inspect it
    vi.mocked(withTenantDb).mockImplementation(async (scope, cb) => {
      await cb({
        authorizationShadowObservation: {
          create: vi.fn(),
        }
      } as any);
    });
  });

  it("shadow mode: returns legacy decision when PARITY (ALLOW/ALLOW)", async () => {
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(true);
    vi.mocked(authorize).mockResolvedValueOnce({
      allowed: true,
      reasonCode: "ALLOW_ACTIVE_ASSIGNMENT",
      matchedAssignmentIds: ["ass-1"],
      matchedEntitlementIds: ["ent-1"],
      evaluatedAt: new Date(),
    });

    const result = await checkPermission(auth, req);
    
    // Gateway always returns legacy decision in shadow mode
    expect(result).toBe(true);
    expect(hasLegacyPermission).toHaveBeenCalledWith(auth, req.action, req.resource);
    expect(authorize).toHaveBeenCalledWith(auth, req);
  });

  it("shadow mode: returns legacy decision when PARITY (DENY/DENY)", async () => {
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(false);
    vi.mocked(authorize).mockResolvedValueOnce({
      allowed: false,
      reasonCode: "DENY_NO_ACTIVE_ASSIGNMENT",
      matchedAssignmentIds: [],
      matchedEntitlementIds: [],
      evaluatedAt: new Date(),
    });

    const result = await checkPermission(auth, req);
    expect(result).toBe(false);
  });

  it("shadow mode: returns legacy decision when DIVERGENCE (ALLOW/DENY)", async () => {
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(true); // Legacy Allows (e.g., admin bypass)
    vi.mocked(authorize).mockResolvedValueOnce({
      allowed: false, // Native denies
      reasonCode: "DENY_NO_ACTIVE_ASSIGNMENT",
      matchedAssignmentIds: [],
      matchedEntitlementIds: [],
      evaluatedAt: new Date(),
    });

    const result = await checkPermission(auth, req);
    expect(result).toBe(true); // Must not break the app
  });

  it("shadow mode: returns legacy decision when DIVERGENCE (DENY/ALLOW)", async () => {
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(false); 
    vi.mocked(authorize).mockResolvedValueOnce({
      allowed: true,
      reasonCode: "ALLOW_ACTIVE_ASSIGNMENT",
      matchedAssignmentIds: [],
      matchedEntitlementIds: [],
      evaluatedAt: new Date(),
    });

    const result = await checkPermission(auth, req);
    expect(result).toBe(false); // Must not give access prematurely
  });

  it("shadow mode: handles NATIVE_ERROR without affecting legacy response", async () => {
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(true);
    vi.mocked(authorize).mockRejectedValueOnce(new Error("DB Connection Lost"));

    const result = await checkPermission(auth, req);
    expect(result).toBe(true); // Legacy remains authoritative
  });

  it("legacy mode: skips native evaluation entirely", async () => {
    process.env.AUTHZ_MODE = "legacy";
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(true);
    
    const result = await checkPermission(auth, req);
    expect(result).toBe(true);
    expect(authorize).not.toHaveBeenCalled();
  });
});
