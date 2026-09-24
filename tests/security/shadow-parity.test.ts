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

  it("Legacy ALLOW / Native DENY => Observation DIVERGENCE, Runtime ALLOW", async () => {
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(true);
    vi.mocked(authorize).mockResolvedValueOnce({
      allowed: false,
      reasonCode: "DENY_NO_ACTIVE_ASSIGNMENT",
      matchedAssignmentIds: [],
      matchedEntitlementIds: [],
      evaluatedAt: new Date(),
    });

    const result = await checkPermission(auth, req);
    
    expect(result).toBe(true); // Runtime remains legacy ALLOW
    
    // Verify observation
    const createSpy = vi.mocked(withTenantDb).mock.calls[0][1] as any;
    const mockTx = { authorizationShadowObservation: { create: vi.fn() } };
    await createSpy(mockTx);
    expect(mockTx.authorizationShadowObservation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DIVERGENCE" }) })
    );
  });

  it("Legacy DENY / Native ALLOW => Observation DIVERGENCE, Runtime DENY", async () => {
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(false);
    vi.mocked(authorize).mockResolvedValueOnce({
      allowed: true,
      reasonCode: "ALLOW_ACTIVE_ASSIGNMENT",
      matchedAssignmentIds: ["ass-1"],
      matchedEntitlementIds: ["ent-1"],
      evaluatedAt: new Date(),
    });

    const result = await checkPermission(auth, req);
    
    expect(result).toBe(false); // Runtime remains legacy DENY
    
    const createSpy = vi.mocked(withTenantDb).mock.calls[0][1] as any;
    const mockTx = { authorizationShadowObservation: { create: vi.fn() } };
    await createSpy(mockTx);
    expect(mockTx.authorizationShadowObservation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DIVERGENCE" }) })
    );
  });

  it("Legacy DENY / Native DENY => Observation PARITY, Runtime DENY", async () => {
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
    
    const createSpy = vi.mocked(withTenantDb).mock.calls[0][1] as any;
    const mockTx = { authorizationShadowObservation: { create: vi.fn() } };
    await createSpy(mockTx);
    expect(mockTx.authorizationShadowObservation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PARITY" }) })
    );
  });

  it("Legacy ALLOW / Native DB failure => Observation NATIVE_ERROR, Runtime ALLOW", async () => {
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(true);
    vi.mocked(authorize).mockRejectedValueOnce(new Error("DB Connection Lost"));

    const result = await checkPermission(auth, req);
    
    expect(result).toBe(true); // Legacy remains authoritative
    
    const createSpy = vi.mocked(withTenantDb).mock.calls[0][1] as any;
    const mockTx = { authorizationShadowObservation: { create: vi.fn() } };
    await createSpy(mockTx);
    expect(mockTx.authorizationShadowObservation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "NATIVE_ERROR" }) })
    );
  });

  it("Legacy ALLOW / Native ALLOW / Observation insert fails => Runtime ALLOW", async () => {
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(true);
    vi.mocked(authorize).mockResolvedValueOnce({
      allowed: true,
      reasonCode: "ALLOW_ACTIVE_ASSIGNMENT",
      matchedAssignmentIds: ["ass-1"],
      matchedEntitlementIds: ["ent-1"],
      evaluatedAt: new Date(),
    });
    
    vi.mocked(withTenantDb).mockRejectedValueOnce(new Error("RLS Observation Insert Failed"));

    // Should not throw, should return true
    const result = await checkPermission(auth, req);
    expect(result).toBe(true);
  });

  it("legacy mode: skips native evaluation entirely", async () => {
    process.env.AUTHZ_MODE = "legacy";
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(true);
    
    const result = await checkPermission(auth, req);
    expect(result).toBe(true);
    expect(authorize).not.toHaveBeenCalled();
  });
});
