import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { testProviderConnection, type ConnectionTestDependencies } from "../../lib/admin/provider-connection-test";
import type { OidcProbeInput, OidcProbeResult } from "../../lib/provider-adapters/implementations/oidc/probe";
import { LUXIA_ORG_ADMIN_V1 } from "../../lib/auth/native-role-catalog";
import { GOVERNANCE_ADMIN_V2 } from "../../lib/resources/admin-bundle";
import { activateWithEvidence } from "../helpers/activation-evidence";

// F4, slice S3 on PostgreSQL: the connection test service as app_user (rawPrisma), with the network probe stubbed.
// The owner (BYPASSRLS) sets up and reads what the runtime cannot.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const suffix = randomUUID().slice(0, 8);
const change = () => `test:${randomUUID()}`;
let owner: PrismaClient;

type Org = { organizationId: string; tenantId: string; admin: string; member: string; local: string };
async function organization(name: string): Promise<Org> {
  const organizationId = randomUUID(); const tenantId = randomUUID();
  const scope = { organizationId, tenantId };
  await owner.organization.create({ data: { id: organizationId, name, slug: `${name}-${suffix}` } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const local = await owner.providerConnection.create({ data: { organizationId, providerType: "LUXIA_LOCAL", externalScopeId: tenantId, name: "LUXIA Local" } });
  await owner.providerConnectionTenantScope.create({ data: { ...scope, providerConnectionId: local.id } });
  const admin = (await owner.subject.create({ data: { ...scope, type: "HUMAN", name: "Admin", lifecycleState: "ACTIVE" } })).id;
  const member = (await owner.subject.create({ data: { ...scope, type: "HUMAN", name: "Member", lifecycleState: "ACTIVE" } })).id;
  for (const key of [...LUXIA_ORG_ADMIN_V1.entitlements, ...GOVERNANCE_ADMIN_V2]) {
    const [resource, action] = key.split(".");
    const entitlement = await owner.entitlement.create({ data: { ...scope, key, resource, action } });
    await owner.assignment.create({ data: { ...scope, subjectId: admin, entitlementId: entitlement.id, source: "DIRECT", sourceRef: "test" } });
  }
  return { organizationId, tenantId, admin, member, local: local.id };
}
const as = (org: Org, subjectId = org.admin) => ({ organizationId: org.organizationId, tenantId: org.tenantId, subjectId });
const lock = (tx: Prisma.TransactionClient, org: Org) =>
  tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${org.organizationId}:${org.tenantId}`}, 0))::text`;
/** An OIDC_GENERIC connection in the tenant scope, DRAFT, with a configuration (written as the owner, under the lock). */
async function oidcConnection(org: Org, options: { configure?: boolean } = {}): Promise<string> {
  const connection = await owner.providerConnection.create({ data: {
    organizationId: org.organizationId, providerType: "OIDC_GENERIC", status: "DRAFT", externalScopeId: `oidc-${randomUUID()}`, name: "Generic IdP" } });
  await owner.providerConnectionTenantScope.create({ data: { organizationId: org.organizationId, tenantId: org.tenantId, providerConnectionId: connection.id } });
  if (options.configure ?? true) await owner.$transaction(async (tx) => {
    await lock(tx, org);
    await tx.providerOidcConfiguration.create({ data: { organizationId: org.organizationId, providerConnectionId: connection.id, issuer: "https://idp.example.com", clientId: "luxia" } });
  });
  return connection.id;
}
const setStatus = (org: Org, id: string, status: string) => owner.$transaction(async (tx) => {
  await lock(tx, org);
  await tx.$executeRawUnsafe(`UPDATE "ProviderConnection" SET status = '${status}' WHERE id = '${id}'`);
});
/** A stub probe that records its calls and answers as told. */
function stub(answer: OidcProbeResult | (() => Promise<OidcProbeResult>)) {
  const calls: OidcProbeInput[] = [];
  const dependencies: ConnectionTestDependencies = { probe: async (input) => { calls.push(input); return typeof answer === "function" ? answer() : answer; } };
  return { calls, dependencies };
}
const PASSED: OidcProbeResult = { outcome: "PASSED", reasonCode: "DISCOVERY_PASSED", metadata: { issuerHost: "idp.example.com", usableKeys: 1 } };
const FAILED: OidcProbeResult = { outcome: "FAILED", reasonCode: "OUTBOUND_PRIVATE_ADDRESS", metadata: { issuerHost: "idp.example.com" } };
const statusOf = async (id: string) => (await owner.providerConnection.findUniqueOrThrow({ where: { id } })).status;
const runsOf = (id: string) => owner.providerTestRun.findMany({ where: { providerConnectionId: id }, orderBy: { occurredAt: "asc" } });
const eventOf = (changeId: string) => owner.canonicalAdminAuditEvent.findFirstOrThrow({ where: { changeId } });
const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error as { code?: string }).code ?? String(error));

describe.runIf(enabled)("F4 S3: connection test (PostgreSQL, app_user, probe stubbed)", () => {
  let a: Org, b: Org;
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    a = await organization("s3a"); b = await organization("s3b");
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("a passing test records the run on the current configuration hash, moves DRAFT to TESTING and is journaled", async () => {
    const id = await oidcConnection(a);
    const probe = stub(PASSED);
    const cid = change();
    const result = await testProviderConnection(as(a), cid, id, probe.dependencies);
    expect(probe.calls).toEqual([{ issuer: "https://idp.example.com", idTokenAlgorithm: "RS256", clientAuthMethod: "client_secret_basic" }]);
    const configuration = await owner.providerOidcConfiguration.findUniqueOrThrow({ where: { providerConnectionId: id } });
    expect(result).toMatchObject({ outcome: "PASSED", reasonCode: "DISCOVERY_PASSED", from: "DRAFT", to: "TESTING", configurationHash: configuration.configurationHash });
    expect(await statusOf(id)).toBe("TESTING");
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ id: result.testRunId, kind: "DISCOVERY", outcome: "PASSED", reasonCode: "DISCOVERY_PASSED",
      configurationHash: configuration.configurationHash, actorSubjectId: a.admin, metadata: { issuerHost: "idp.example.com", usableKeys: 1 } });
    expect(await eventOf(cid)).toMatchObject({ operation: "PROVIDER.CONNECTION.TEST", result: "SUCCESS",
      metadata: { providerConnectionId: id, outcome: "PASSED", reasonCode: "DISCOVERY_PASSED", from: "DRAFT", to: "TESTING" } });
    // A second passing test keeps TESTING and records a second run.
    await testProviderConnection(as(a), change(), id, stub(PASSED).dependencies);
    expect(await statusOf(id)).toBe("TESTING");
    expect(await runsOf(id)).toHaveLength(2);
  });

  it("a failed test is recorded with its reason, leaves the connection DRAFT, and is journaled as refused", async () => {
    const id = await oidcConnection(a);
    const cid = change();
    const result = await testProviderConnection(as(a), cid, id, stub(FAILED).dependencies);
    expect(result).toMatchObject({ outcome: "FAILED", reasonCode: "OUTBOUND_PRIVATE_ADDRESS", from: "DRAFT", to: "DRAFT" });
    expect(await statusOf(id)).toBe("DRAFT");
    expect(await runsOf(id)).toMatchObject([{ outcome: "FAILED", reasonCode: "OUTBOUND_PRIVATE_ADDRESS" }]);
    expect(await eventOf(cid)).toMatchObject({ operation: "PROVIDER.CONNECTION.TEST", result: "DENIED", metadata: { reasonCode: "OUTBOUND_PRIVATE_ADDRESS" } });
    // A probe that throws is a recorded failure, never an unhandled error.
    const thrown = await testProviderConnection(as(a), change(), id, stub(async () => { throw new Error("boom"); }).dependencies);
    expect(thrown).toMatchObject({ outcome: "FAILED", reasonCode: "PROBE_FAILED" });
  });

  it("refusals are journaled and call no outside host: a member, another type, an active connection, no configuration, another organization", async () => {
    const draft = await oidcConnection(a);
    const active = await oidcConnection(a);
    await activateWithEvidence(owner, a, active);
    const unconfigured = await oidcConnection(a, { configure: false });
    const foreign = await oidcConnection(b);
    // The ACTIVE connection carries its activation evidence (a DISCOVERY and a PROOF run, required by the database since
    // S5): the runs are captured before the refused calls, which must add none.
    const runIds = async (id: string) => (await runsOf(id)).map((run) => run.id);
    const before = new Map<string, string[]>();
    for (const id of [draft, active, unconfigured, foreign]) before.set(id, await runIds(id));
    expect(before.get(active)).toHaveLength(2);
    const cases: Array<[string, (changeId: string) => Promise<unknown>, string]> = [];
    const probe = stub(PASSED);
    cases.push(["a member without providers.manage", (cid) => testProviderConnection(as(a, a.member), cid, draft, probe.dependencies), "FORBIDDEN"]);
    cases.push(["the local connection", (cid) => testProviderConnection(as(a), cid, a.local, probe.dependencies), "CONNECTION_TEST_UNSUPPORTED"]);
    cases.push(["an ACTIVE connection", (cid) => testProviderConnection(as(a), cid, active, probe.dependencies), "CONNECTION_TEST_NOT_ALLOWED"]);
    cases.push(["no configuration", (cid) => testProviderConnection(as(a), cid, unconfigured, probe.dependencies), "CONNECTION_NOT_CONFIGURED"]);
    cases.push(["another organization's connection", (cid) => testProviderConnection(as(a), cid, foreign, probe.dependencies), "PROVIDER_NOT_FOUND"]);
    cases.push(["an unknown connection", (cid) => testProviderConnection(as(a), cid, randomUUID(), probe.dependencies), "PROVIDER_NOT_FOUND"]);
    for (const [name, run, expected] of cases) {
      const cid = change();
      expect(await code(run(cid)), name).toBe(expected);
      expect(await eventOf(cid), name).toMatchObject({ operation: "PROVIDER.CONNECTION.TEST.DENIED", result: "DENIED", metadata: { reasonCode: expected } });
    }
    expect(probe.calls).toEqual([]);
    for (const id of [draft, active, unconfigured, foreign]) expect(await runIds(id), id).toEqual(before.get(id));
    expect(await statusOf(draft)).toBe("DRAFT");
  });

  it("a configuration changed while the probe ran is refused: nothing recorded, the status unchanged", async () => {
    const id = await oidcConnection(a);
    const probe = stub(async () => {
      await owner.$transaction(async (tx) => {
        await lock(tx, a);
        await tx.providerOidcConfiguration.update({ where: { providerConnectionId: id }, data: { scopes: "openid email" } });
      });
      return PASSED;
    });
    const cid = change();
    expect(await code(testProviderConnection(as(a), cid, id, probe.dependencies))).toBe("CONNECTION_CONFIGURATION_CHANGED");
    expect(await runsOf(id)).toEqual([]);
    expect(await statusOf(id)).toBe("DRAFT");
    expect(await eventOf(cid)).toMatchObject({ operation: "PROVIDER.CONNECTION.TEST.DENIED", metadata: { reasonCode: "CONNECTION_CONFIGURATION_CHANGED" } });
  });

  it("the runtime sees an organization's test runs only inside its scope", async () => {
    const id = await oidcConnection(a);
    await testProviderConnection(as(a), change(), id, stub(PASSED).dependencies);
    expect(await rawPrisma.providerTestRun.count({ where: { providerConnectionId: id } })).toBe(0);
    const inB = await rawPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${b.organizationId}, true)::text`;
      return tx.providerTestRun.count({ where: { providerConnectionId: id } });
    });
    expect(inB).toBe(0);
  });
});
