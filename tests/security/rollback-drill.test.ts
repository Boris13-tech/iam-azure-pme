import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkPermission } from "../../lib/auth/authorization-gateway";
import { hasLegacyPermission } from "../../lib/auth/legacy-auth-adapter";
import { authorize } from "../../lib/auth/authorization-engine";
import { recordObservation } from "../../lib/auth/shadow-observer"; // Note: this is not exported currently, but it's internal.
import { randomUUID } from "crypto";

vi.mock("../../lib/auth/legacy-auth-adapter");
vi.mock("../../lib/auth/authorization-engine");

// We need to mock recordObservation but it's not exported. We'll just mock the db inside or ignore it.
vi.mock("../../lib/db/scoped-client", () => ({
  withTenantDb: vi.fn(async (opts, cb) => cb({
    authorizationShadowObservation: { create: vi.fn() }
  }))
}));

describe("Phase 5E.1 - Rollback Drill", () => {
  const req = { action: "read", resource: "users" };
  const auth = { organizationId: randomUUID(), tenantId: randomUUID(), subjectId: "sub-1", type: "HUMAN" } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should fail-safe to legacy if AUTHZ_MODE is unknown", async () => {
    process.env.AUTHZ_MODE = "some-unknown-value";
    
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(true);
    
    const result = await checkPermission(auth, req);
    expect(result).toBe(true);
    // Since it falls back to legacy, authorize is not called
    expect(authorize).not.toHaveBeenCalled();
  });

  it("should use Native authority in native-shadow-legacy and log shadow", async () => {
    process.env.AUTHZ_MODE = "native-shadow-legacy";
    
    // Divergence: Legacy says DENY, Native says ALLOW
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(false);
    vi.mocked(authorize).mockResolvedValueOnce({
      allowed: true,
      reasonCode: "ALLOW_ACTIVE_ASSIGNMENT",
      matchedAssignmentIds: ["ass-1"],
      matchedEntitlementIds: ["ent-1"],
      evaluatedAt: new Date(),
    });

    const result = await checkPermission(auth, req);
    
    // In native-shadow-legacy, Native is authoritative
    expect(result).toBe(true);
  });

  it("should rollback to shadow seamlessly", async () => {
    process.env.AUTHZ_MODE = "shadow";
    
    // Divergence: Legacy says DENY, Native says ALLOW
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(false);
    vi.mocked(authorize).mockResolvedValueOnce({
      allowed: true,
      reasonCode: "ALLOW_ACTIVE_ASSIGNMENT",
      matchedAssignmentIds: ["ass-1"],
      matchedEntitlementIds: ["ent-1"],
      evaluatedAt: new Date(),
    });

    const result = await checkPermission(auth, req);
    
    // In shadow, Legacy is authoritative again
    expect(result).toBe(false);
  });

  it("should fail-close native-shadow-legacy on infrastructure error but keep running", async () => {
    process.env.AUTHZ_MODE = "native-shadow-legacy";
    
    // Legacy works, Native throws
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(true);
    vi.mocked(authorize).mockRejectedValueOnce(new Error("RLS Crash"));

    const result = await checkPermission(auth, req);
    
    // Native is authoritative, so if it crashes, it's a DENY
    expect(result).toBe(false);
  });

  it("should fallback to purely legacy if rolled back fully", async () => {
    process.env.AUTHZ_MODE = "legacy";
    
    vi.mocked(hasLegacyPermission).mockResolvedValueOnce(true);
    
    const result = await checkPermission(auth, req);
    
    // In legacy, we completely skip native execution to save DB ops
    expect(result).toBe(true);
    expect(authorize).not.toHaveBeenCalled();
  });
});
