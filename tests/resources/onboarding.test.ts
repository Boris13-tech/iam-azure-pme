import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";
import { INTERNAL_RESOURCE as c, INTERNAL_ENTITLEMENT_KEY as key } from "../../lib/resources/internal-capability";
import { exerciseInternalCapability, internalBinding } from "../../lib/resources/onboarding";
import { GET } from "../../app/api/resources/protected-resource-demo/route";

const mocks = vi.hoisted(() => ({ tx: {} as unknown, auth: {} as unknown, resolve: vi.fn() }));
vi.mock("../../lib/db/scoped-client", () => ({ withTenantDb: async (_scope: unknown, work: (tx: unknown) => unknown) => work(mocks.tx) }));
vi.mock("../../lib/auth/require-auth", () => ({ requireAuth: () => mocks.resolve() }));
const auth = { organizationId: c.organizationId, tenantId: c.tenantId, subjectId: "real-session-subject" };
function fixture(options: { active?: boolean; grant?: boolean; resource?: string; action?: string; kind?: string } = {}) {
  const scope = { id: c.scopeId, organizationId: c.organizationId, tenantId: c.tenantId, active: true,
    kind: options.kind ?? "RESOURCE", resourceId: options.resource ?? c.resourceId, members: [] };
  return {
    $queryRaw: vi.fn(), subject: { findFirst: vi.fn().mockImplementation(({ where }) =>
      where.lifecycleState === "ACTIVE" && options.active === false ? null : { id: auth.subjectId }) },
    resource: { findFirst: vi.fn().mockResolvedValue({ id: c.resourceId, active: true, type: c.type, providerConnectionId: null }) },
    resourceScope: { findFirst: vi.fn().mockResolvedValue(scope) },
    entitlement: { findFirst: vi.fn().mockResolvedValue({ id: c.entitlementId, active: true, resourceScopeId: c.scopeId,
      action: options.action ?? c.action, key, resource: "resource-scope" }) },
    assignment: { findMany: vi.fn().mockResolvedValue(options.grant ? [{ id: "assignment", entitlementId: c.entitlementId,
      entitlement: { resourceScopeId: c.scopeId, resourceScope: scope } }] : []) },
    canonicalAdminAuditEvent: { create: vi.fn().mockResolvedValue({ id: "evidence" }) },
  };
}
describe("first internal server capability — no implicit grants", () => {
  beforeEach(() => { mocks.tx = fixture(); mocks.resolve.mockResolvedValue(auth); });
  it("missing grant commits DENIED evidence, then HTTP 403", async () => {
    const response = await GET();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "RESOURCE_ACCESS_DENIED", evidenceId: "evidence" });
    const tx = mocks.tx as ReturnType<typeof fixture>;
    expect(tx.canonicalAdminAuditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      result: "DENIED", actorSubjectId: auth.subjectId, operation: "RESOURCE.CAPABILITY.READ",
    }) }));
  });
  it("fixed server claims and native effective chain produce ALLOW only", async () => {
    mocks.tx = fixture({ grant: true });
    expect((await GET()).status).toBe(200);
    const tx = mocks.tx as ReturnType<typeof fixture>;
    expect(tx.assignment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      subjectId: auth.subjectId, status: "ACTIVE", source: { not: "LEGACY_ROLE" },
      entitlement: expect.objectContaining({ key, action: "resource.read", active: true }),
    }) }));
  });
  it.each([{ active: false }, { resource: "other" }, { action: "other.read" }, { kind: "TENANT" }, { kind: "RESOURCE_GROUP" }])("rejects inactive or broadened binding %j", async options => {
    mocks.tx = fixture({ ...options, grant: true });
    expect((await GET()).status).toBe(403);
  });
  it("foreign tenant has no identity/binding lookup outside its own scope and no metadata leak", async () => {
    const tx = fixture({ grant: true }); mocks.tx = tx;
    const result = await exerciseInternalCapability({ ...auth, tenantId: "foreign" });
    expect(result.allowed).toBe(false);
    expect(tx.resource.findFirst).not.toHaveBeenCalled();
    expect(tx.assignment.findMany).not.toHaveBeenCalled();
    expect(tx.canonicalAdminAuditEvent.create.mock.calls[0][0].data.metadata).toEqual({ reasonCode: "RESOURCE_ACCESS_DENIED" });
  });
  it("session absence fails 401 without resource evaluation", async () => {
    mocks.resolve.mockRejectedValue(new Error("UNAUTHORIZED"));
    expect((await GET()).status).toBe(401);
    expect((mocks.tx as ReturnType<typeof fixture>).resource.findFirst).not.toHaveBeenCalled();
  });
  it("audit persistence failure never returns protected payload", async () => {
    const tx = fixture({ grant: true }); tx.canonicalAdminAuditEvent.create.mockRejectedValue(new Error("DB_UNAVAILABLE")); mocks.tx = tx;
    expect((await GET()).status).toBe(500);
  });
  it("only exact RESOURCE binding is accepted", async () => {
    expect(await internalBinding(fixture({ kind: "TENANT" }) as unknown as Prisma.TransactionClient, auth)).toBe(false);
  });
  it("architecture keeps request claims, bootstrap writes and legacy out", () => {
    const route = readFileSync("app/api/resources/protected-resource-demo/route.ts", "utf8");
    expect(route).toContain("await requireAuth()");
    expect(route).not.toMatch(/searchParams|request\.json|headers\.get|checkPermission/);
    const source = readFileSync("lib/resources/onboarding.ts", "utf8");
    expect(source).not.toMatch(/assignment\.(create|update)|\.userRole\.|\.permission\.|from .*legacy|grantAssignment\(/i);
    expect(source).toContain('deny("SELF_GRANT_FORBIDDEN")');
    expect(source).toContain('deny("FIRST_OWNER_BOOTSTRAP_REQUIRED")');
    const sql = readFileSync("prisma/migrations/20261008040000_resource_onboarding_evidence/migration.sql", "utf8");
    expect(sql).not.toMatch(/INSERT INTO|UPDATE "|DELETE FROM|GRANT EXECUTE|DROP /);
    expect(sql).toContain("FROM PUBLIC");
  });
});
