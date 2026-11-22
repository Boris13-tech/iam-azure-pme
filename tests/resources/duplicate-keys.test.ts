import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), db: vi.fn() }));
vi.mock("../../lib/auth/require-auth", () => ({ requireAuth: mocks.auth }));
vi.mock("../../lib/db/scoped-client", () => ({ withTenantDb: mocks.db }));
import { POST as governance } from "../../app/api/canonical/resource-governance/[...path]/route";
import { POST as sodRoute } from "../../app/api/canonical/sod/[...path]/route";
import { canonicalAdminErrorResponse } from "../../lib/admin/http";
import { CanonicalAdminError } from "../../lib/admin/canonical-administration";
import { REFUSAL_LABELS } from "../../lib/ui/activity-labels";

const auth = { organizationId: "org", tenantId: "tenant", subjectId: "11111111-1111-4111-8111-111111111111" };
const scopeId = "22222222-2222-4222-8222-222222222222";
const existing = { id: "33333333-3333-4333-8333-333333333333" };
// The key lookup of each surface returns an existing row; everything else is a permitted, active administrator.
function fakeTx() {
  const created = vi.fn(() => { throw new Error("must not insert a duplicate"); });
  return {
    $queryRaw: vi.fn(async () => []),
    canonicalAdminAuditEvent: { findFirst: vi.fn(async () => null), create: vi.fn(async (args: unknown) => args) },
    subject: { findFirst: vi.fn(async () => ({ id: auth.subjectId, lifecycleState: "ACTIVE" })) },
    assignment: { findFirst: vi.fn(async () => ({ id: "grant" })) },
    resourceScope: { findFirst: vi.fn(async (_args?: unknown) => existing), create: created },
    entitlement: { findFirst: vi.fn(async (_args?: unknown) => existing), create: created },
    soDPolicy: { findFirst: vi.fn(async (_args?: unknown) => existing), create: created },
    created,
  };
}
const request = (path: string, body: unknown) => new Request(`http://localhost/api/canonical/${path}`, {
  method: "POST", headers: { "content-type": "application/json", "x-luxia-change-id": "duplicate-key-test" }, body: JSON.stringify(body) });
const params = (...path: string[]) => ({ params: Promise.resolve({ path }) });

describe("duplicate keys answer 409 with a specific code", () => {
  let tx: ReturnType<typeof fakeTx>;
  beforeEach(() => {
    vi.clearAllMocks(); tx = fakeTx();
    mocks.auth.mockResolvedValue(auth);
    mocks.db.mockImplementation(async (_scope: unknown, work: (client: unknown) => unknown) => work(tx));
  });
  const cases = [
    { name: "scope", call: () => governance(request("resource-governance/scopes", { key: "payments", kind: "TENANT" }), params("scopes")),
      code: "SCOPE_KEY_TAKEN", operation: "RESOURCE.SCOPE.CREATE.DENIED" },
    { name: "entitlement", call: () => governance(request("resource-governance/entitlements", { scopeId, action: "approve", label: "Approve" }), params("entitlements")),
      code: "ENTITLEMENT_KEY_TAKEN", operation: "RESOURCE.ENTITLEMENT.CREATE.DENIED" },
    { name: "SoD policy", call: () => sodRoute(request("sod/policies", { key: "payments", scopeId }), params("policies")),
      code: "SOD_POLICY_KEY_TAKEN", operation: "SOD.POLICY.CREATE.DENIED" },
  ];
  for (const { name, call, code, operation } of cases) {
    it(`${name}: 409 ${code}, no insert, DENIED evidence with the reason code only`, async () => {
      const response = await call();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: code });
      expect(tx.created).not.toHaveBeenCalled();
      expect(tx.canonicalAdminAuditEvent.create).toHaveBeenCalledTimes(1);
      expect(tx.canonicalAdminAuditEvent.create.mock.calls[0][0]).toMatchObject({ data: { operation, result: "DENIED", changeId: "duplicate-key-test", metadata: { reasonCode: code } } });
      expect(REFUSAL_LABELS[code]).toMatch(/déjà/);
    });
  }
  it("the entitlement lookup uses the deterministic key, inactive rows included", async () => {
    await governance(request("resource-governance/entitlements", { scopeId, action: "approve", label: "Approve" }), params("entitlements"));
    expect(tx.entitlement.findFirst.mock.calls[0][0]).toEqual({ where: { organizationId: "org", tenantId: "tenant", key: `resource-scope:${scopeId}:approve` }, select: { id: true } });
  });
  it("an unexpected unique violation stays a 500 that names no constraint, table or column", async () => {
    const violation = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`organizationId`,`tenantId`,`key`)',
      { code: "P2002", clientVersion: "test", meta: { target: "ResourceScope_organizationId_tenantId_key_key", modelName: "ResourceScope" } });
    const response = canonicalAdminErrorResponse(violation);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "CANONICAL_ADMIN_OPERATION_FAILED" });
    expect(body).not.toMatch(/ResourceScope|tenantId|_key|P2002|constraint/i);
    expect(canonicalAdminErrorResponse(new CanonicalAdminError("SCOPE_KEY_TAKEN", 409)).status).toBe(409);
  });
  it("each create checks its key before inserting", () => {
    const service = readFileSync("lib/resources/service.ts", "utf8"), sod = readFileSync("lib/resources/sod-service.ts", "utf8");
    const section = (source: string, from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to));
    const scope = section(service, "export function createScope", "export function listScopes");
    expect(scope.indexOf('"SCOPE_KEY_TAKEN"')).toBeGreaterThan(-1);
    expect(scope.indexOf('"SCOPE_KEY_TAKEN"')).toBeLessThan(scope.indexOf("tx.resourceScope.create"));
    const entitlement = section(service, "export function createEntitlement", "export function revokeEntitlement");
    expect(entitlement.indexOf('"ENTITLEMENT_KEY_TAKEN"')).toBeGreaterThan(-1);
    expect(entitlement.indexOf('"ENTITLEMENT_KEY_TAKEN"')).toBeLessThan(entitlement.indexOf("tx.entitlement.create"));
    const policy = section(sod, "export function createSoDPolicy", "export function setSoDPolicyStatus");
    expect(policy.indexOf('"SOD_POLICY_KEY_TAKEN"')).toBeGreaterThan(-1);
    expect(policy.indexOf('"SOD_POLICY_KEY_TAKEN"')).toBeLessThan(policy.indexOf("tx.soDPolicy.create"));
  });
});
