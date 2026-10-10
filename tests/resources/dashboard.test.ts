import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), platform: vi.fn(), db: vi.fn() }));
vi.mock("../../lib/auth/require-auth", () => ({ requireAuth: mocks.auth }));
vi.mock("../../lib/platform/context", () => ({ loadPlatformContext: mocks.platform }));
vi.mock("../../lib/db/scoped-client", () => ({ withTenantDb: mocks.db }));
import { GET } from "../../app/api/dashboard/route";
describe("Real tenant dashboard", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ organizationId: "org", tenantId: "tenant" }); });
  it("unauthenticated reads are denied", async () => { mocks.auth.mockRejectedValue(new Error("UNAUTHORIZED")); expect((await GET()).status).toBe(401); expect(mocks.db).not.toHaveBeenCalled(); });
  it("no permission means no underlying metric or audit read", async () => {
    mocks.platform.mockResolvedValue({ entitlements: [] });
    mocks.db.mockImplementation(async (_scope, work) => work({}));
    const response = await GET(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ activeUsers: null, protectedResources: null, activeSessions: null, rolesConfigured: null, providerScopes: null, recentEvents: [] });
  });
  it("authorized metrics and events originate from the scoped database", async () => {
    const event = { id: "event", operation: "RESOURCE.CREATE", result: "SUCCESS", occurredAt: new Date() };
    const resource = { count: vi.fn().mockResolvedValue(7) }, audit = { findMany: vi.fn().mockResolvedValue([event]) };
    mocks.platform.mockResolvedValue({ entitlements: ["resources.read", "audit.read"] });
    mocks.db.mockImplementation(async (scope, work) => { expect(scope).toEqual({ organizationId: "org", tenantId: "tenant" }); return work({ resource, canonicalAdminAuditEvent: audit }); });
    const data = await (await GET()).json(); expect(data.protectedResources).toBe(7); expect(data.recentEvents[0].id).toBe("event");
    expect(audit.findMany.mock.calls[0][0].select).toEqual({ id: true, operation: true, result: true, occurredAt: true });
    expect(resource.count.mock.calls[0][0].where).toEqual({ organizationId: "org", tenantId: "tenant", active: true });
  });
  it("dashboard has no invented activity, health or recommendations", () => {
    const ui = readFileSync("app/dashboard/page.tsx", "utf8");
    expect(ui).not.toMatch(/Opérationnel|recommandations prioritaires|Connexion réussie|il y a|<a>Gérer/);
    // Dashboard v1 renders only the server-gated posture contract (no client-side permission decisions).
    expect(ui).toContain('fetch("/api/canonical/posture"'); expect(ui).toContain("data.attention.map"); expect(ui).toContain("data.sections[id]");
    expect(ui).not.toMatch(/entitlements\.includes/);
    expect(readFileSync("lib/dashboard/posture.ts", "utf8")).toContain("entitlement: { active: true, resourceScopeId: null }");
    expect(readFileSync("lib/platform/context.ts", "utf8")).toContain("entitlement: { active: true, resourceScopeId: null }");
  });
});
