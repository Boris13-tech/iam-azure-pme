import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { evaluateResourceAccess, authorize } from "../../lib/resources/authorization";

vi.mock("../../lib/db/scoped-client", () => ({ withTenantDb: vi.fn(async (_scope, work) => work({})) }));
const request = { organizationId: "org", tenantId: "tenant", subjectId: "subject", resourceId: "resource", entitlementKey: "scoped:read", action: "read" };
function fixture(options: { subject?: boolean; resource?: boolean; grant?: boolean; kind?: string; target?: string; active?: boolean; members?: string[] } = {}) {
  return { subject: { findFirst: vi.fn().mockResolvedValue(options.subject === false ? null : { id: "subject" }) },
    resource: { findFirst: vi.fn().mockResolvedValue(options.resource === false ? null : { id: "resource" }) },
    assignment: { findMany: vi.fn().mockResolvedValue(options.grant === false ? [] : [{ id: "assignment", entitlementId: "entitlement", entitlement: {
      resourceScopeId: "scope", resourceScope: { id: "scope", organizationId: "org", tenantId: "tenant", active: options.active !== false,
        kind: options.kind ?? "RESOURCE", resourceId: options.target ?? "resource", members: (options.members ?? []).map(resourceId => ({ resourceId })) },
    } }]) } } as unknown as Prisma.TransactionClient;
}
describe("resource authorization", () => {
  it("returns full canonical evidence for an exact match", async () => {
    expect(await evaluateResourceAccess(fixture(), request)).toMatchObject({ allowed: true, assignmentIds: ["assignment"], entitlementIds: ["entitlement"], scopeIds: ["scope"] });
  });
  it.each([{ subject: false }, { resource: false }, { grant: false }, { active: false }, { target: "other" }, { kind: "UNKNOWN" }, { kind: "RESOURCE_GROUP", members: ["other"] }])("defaults to DENY: %j", async options => {
    expect((await evaluateResourceAccess(fixture(options), request)).allowed).toBe(false);
  });
  it("requires explicit group membership", async () => {
    expect((await evaluateResourceAccess(fixture({ kind: "RESOURCE_GROUP", members: ["resource"] }), request)).allowed).toBe(true);
  });
  it("tenant scope matches only after scoped subject and resource resolution", async () => {
    expect((await evaluateResourceAccess(fixture({ kind: "TENANT" }), request)).allowed).toBe(true);
    expect((await evaluateResourceAccess(fixture({ kind: "TENANT", resource: false }), request)).allowed).toBe(false);
  });
  it("excludes expired, revoked, legacy-source and unbound grants in SQL predicates", async () => {
    const tx = fixture();
    await evaluateResourceAccess(tx, request);
    expect(tx.assignment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "ACTIVE", source: { not: "LEGACY_ROLE" },
      organizationId: "org", tenantId: "tenant", entitlement: expect.objectContaining({ active: true, resourceScopeId: { not: null } }), AND: expect.any(Array) }) }));
    expect(tx.subject.findFirst).toHaveBeenCalledWith({ where: { organizationId: "org", tenantId: "tenant", id: "subject", lifecycleState: "ACTIVE" } });
  });
  it("unknown context and infrastructure failure deny", async () => {
    expect((await evaluateResourceAccess(fixture(), { ...request, action: "*" })).allowed).toBe(false);
    expect((await authorize(request)).allowed).toBe(false);
  });
});
