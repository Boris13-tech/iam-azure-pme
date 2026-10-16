import { randomBytes, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as login } from "../../app/auth/login/route";
import { GET as callback } from "../../app/auth/callback/route";
import { POST as startProofRoute } from "../../app/api/canonical/providers/[id]/proof/route";
import { startConnectionProof } from "../../lib/admin/provider-connection-proof";
import { applyConnectionTransition, connectionPlanDigest, planConnectionTransition } from "../../lib/admin/provider-connection-lifecycle";
import { withTenantDb } from "../../lib/db/scoped-client";
import { testProviderConnection } from "../../lib/admin/provider-connection-test";
import { SessionStore } from "../../lib/auth/session-store";
import { LUXIA_ORG_ADMIN_V1 } from "../../lib/auth/native-role-catalog";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { OpenIdClientOidcGateway } from "../../lib/provider-adapters/implementations/oidc";
import { GenericOidcAuthenticationProvider, PrismaGenericOidcConfigResolver } from "../../lib/provider-adapters/implementations/oidc-generic";
import { GOVERNANCE_ADMIN_V2 } from "../../lib/resources/admin-bundle";
import { TestIdp, guardedTestFetch, resolver, testSecretStore } from "../helpers/oidc-test-idp";
import { activateWithEvidence, insertAgedRun } from "../helpers/activation-evidence";

// F4, slice S5 on PostgreSQL: the proof sign-in (no session, bound to the administrator who started it) and the first
// activation (TESTING to ACTIVE, on fresh evidence revalidated under lock), through the real services and routes, as
// app_user, against a provider simulated in memory behind the SSRF guard. Test secrets only.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const suffix = randomUUID().slice(0, 8);
const ORIGIN = "http://localhost:3000";
const LOCATOR = "akv://luxia-test-vault/oidc-proof";
vi.setConfig({ testTimeout: 60_000 });

const h = vi.hoisted(() => ({ provider: undefined as unknown, sessionToken: undefined as string | undefined, cookieSet: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "luxia_session" && h.sessionToken ? { name, value: h.sessionToken } : undefined), set: h.cookieSet }),
  headers: async () => ({ get: () => null }),
}));
vi.mock("../../lib/provider-adapters/implementations/oidc-generic/runtime", () => ({ getGenericOidcAuthenticationProvider: () => h.provider }));

let owner: PrismaClient;
let idp: TestIdp;
type Person = { subjectId: string; token: string };
type Org = { organizationId: string; tenantId: string; slug: string; local: string; admin: Person; admin2: Person; member: Person };

async function person(org: Omit<Org, "admin" | "admin2" | "member">, name: string, admin: boolean): Promise<Person> {
  const scope = { organizationId: org.organizationId, tenantId: org.tenantId };
  const subject = await owner.subject.create({ data: { ...scope, type: "HUMAN", name, lifecycleState: "ACTIVE" } });
  if (admin) for (const key of [...LUXIA_ORG_ADMIN_V1.entitlements, ...GOVERNANCE_ADMIN_V2]) {
    const [resource, action] = key.split(".");
    const entitlement = await owner.entitlement.upsert({ where: { organizationId_tenantId_key: { ...scope, key } }, update: {}, create: { ...scope, key, resource, action } });
    await owner.assignment.create({ data: { ...scope, subjectId: subject.id, entitlementId: entitlement.id, source: "DIRECT", sourceRef: "test" } });
  }
  const account = await owner.identityAccount.create({ data: { ...scope, subjectId: subject.id, providerConnectionId: org.local, externalObjectId: `local-${randomUUID()}` } });
  const { rawToken } = await SessionStore.createSession({ ...scope, subjectId: subject.id, identityAccountId: account.id });
  return { subjectId: subject.id, token: rawToken };
}
async function organization(name: string): Promise<Org> {
  const organizationId = randomUUID(); const tenantId = randomUUID(); const slug = `${name}-${suffix}`;
  await owner.organization.create({ data: { id: organizationId, name, slug } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const local = await owner.providerConnection.create({ data: { organizationId, providerType: "LUXIA_LOCAL", externalScopeId: tenantId, name: "LUXIA Local" } });
  await owner.providerConnectionTenantScope.create({ data: { organizationId, tenantId, providerConnectionId: local.id } });
  const base = { organizationId, tenantId, slug, local: local.id };
  return { ...base, admin: await person(base, "Admin", true), admin2: await person(base, "Admin 2", true), member: await person(base, "Member", false) };
}
const as = (org: Org, who: Person = org.admin) => ({ organizationId: org.organizationId, tenantId: org.tenantId, subjectId: who.subjectId, sessionId: "test", identityAccountId: "test" });
const change = () => `test:${randomUUID()}`;
const lock = (tx: Prisma.TransactionClient, org: Org) =>
  tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${org.organizationId}:${org.tenantId}`}, 0))::text`;
const PASSED = { outcome: "PASSED" as const, reasonCode: "DISCOVERY_PASSED", metadata: { issuerHost: "idp-proof.luxia-test.example" } };
const FAILED = { outcome: "FAILED" as const, reasonCode: "JWKS_NO_USABLE_KEY", metadata: {} };

/** A generic connection on the test provider, configured with a secret reference, tested (DRAFT -> TESTING). */
async function testingConnection(org: Org, options: { secret?: boolean; test?: boolean } = {}): Promise<string> {
  const connection = await owner.providerConnection.create({ data: { organizationId: org.organizationId, providerType: "OIDC_GENERIC", status: "DRAFT",
    externalScopeId: `oidc-${randomUUID()}`, name: "Generic IdP" } });
  await owner.providerConnectionTenantScope.create({ data: { organizationId: org.organizationId, tenantId: org.tenantId, providerConnectionId: connection.id } });
  await owner.$transaction(async (tx) => {
    await lock(tx, org);
    await tx.providerOidcConfiguration.create({ data: { organizationId: org.organizationId, providerConnectionId: connection.id, issuer: idp.issuer, clientId: "luxia-proof" } });
    if (options.secret ?? true) await tx.providerSecretReference.create({ data: { organizationId: org.organizationId, providerConnectionId: connection.id,
      purpose: "OIDC_CLIENT", store: "azure-key-vault", locator: LOCATOR, activeVersion: randomBytes(16).toString("hex") } });
  });
  if (options.test ?? true) await testProviderConnection(as(org), change(), connection.id, { probe: async () => PASSED });
  return connection.id;
}
const statusOf = async (id: string) => (await owner.providerConnection.findUniqueOrThrow({ where: { id } })).status;
const runsOf = (id: string, kind: string) => owner.providerTestRun.findMany({ where: { providerConnectionId: id, kind }, orderBy: { occurredAt: "asc" } });
const eventOf = (changeId: string) => owner.canonicalAdminAuditEvent.findFirstOrThrow({ where: { changeId } });
const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error as { code?: string }).code ?? String(error));
const request = (path: string) => new Request(`${ORIGIN}${path}`, { headers: { "x-real-ip": `203.0.113.${randomBytes(1)[0]}-${suffix}` } });
const where = (response: Response) => { const url = new URL(response.headers.get("location") ?? "", ORIGIN); return url.origin === ORIGIN ? `${url.pathname}${url.search}` : url.origin; };
const tokenRequests = () => idp.requests.filter((r) => r.path === "/token").length;

/** A whole proof: started by `starter`, signed in at the provider, completed in the browser holding `browser`'s session. */
async function prove(org: Org, id: string, options: { starter?: Person; browser?: Person | null; beforeCallback?: () => Promise<void> } = {}) {
  const started = await startConnectionProof(as(org, options.starter ?? org.admin), change(), id);
  const { code: authorizationCode, state } = idp.authorize(started.authorizationUrl, "someone-at-the-provider");
  await options.beforeCallback?.();
  h.sessionToken = options.browser === null ? undefined : (options.browser ?? options.starter ?? org.admin).token;
  try {
    return where(await callback(request(`/auth/callback?${new URLSearchParams({ code: authorizationCode, state })}`)));
  } finally { h.sessionToken = undefined; }
}

describe.runIf(enabled)("F4 S5: proof sign-in and first activation (PostgreSQL, app_user)", () => {
  let org: Org;
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    idp = await TestIdp.create("https://idp-proof.luxia-test.example", { "luxia-proof": "test-secret-proof" });
    h.provider = new GenericOidcAuthenticationProvider(new PrismaGenericOidcConfigResolver(),
      new OpenIdClientOidcGateway(testSecretStore({ [LOCATOR]: "test-secret-proof" }), undefined, guardedTestFetch([idp])), resolver());
    org = await organization("s5a");
  }, 180_000);
  beforeEach(() => { idp.reset(); h.cookieSet.mockClear(); h.sessionToken = undefined; });
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("a proof is started through the route by an administrator, bound to purpose, subject and configuration", async () => {
    const id = await testingConnection(org);
    const viaRoute = async (who: Person, changeId: string) => {
      h.sessionToken = who.token;
      try {
        return await startProofRoute(new Request(`${ORIGIN}/api/canonical/providers/${id}/proof`, { method: "POST", headers: { "x-luxia-change-id": changeId } }),
          { params: Promise.resolve({ id }) });
      } finally { h.sessionToken = undefined; }
    };
    // The canonical routes authorize through AUTHZ_MODE. Unset, it falls back to "legacy", where only the legacy role
    // bridge counts and native entitlements do not: the mode every route certification runs in is "native".
    const previousMode = process.env.AUTHZ_MODE;
    process.env.AUTHZ_MODE = "native";
    let response: Response;
    try {
      // The route's own check is live: a member is refused before any provider call.
      expect((await viaRoute(org.member, change())).status).toBe(403);
      expect(idp.requests).toEqual([]);
      const changeId = change();
      response = await viaRoute(org.admin, changeId);
      expect(await eventOf(changeId)).toMatchObject({ operation: "PROVIDER.CONNECTION.PROOF.START", result: "SUCCESS", actorSubjectId: org.admin.subjectId });
    } finally {
      if (previousMode === undefined) delete process.env.AUTHZ_MODE; else process.env.AUTHZ_MODE = previousMode;
    }
    expect(response.status).toBe(200);
    const body = await response.json() as { authorizationUrl: string };
    const state = new URL(body.authorizationUrl).searchParams.get("state")!;
    expect(new URL(body.authorizationUrl).origin).toBe(idp.issuer);
    const configuration = await owner.providerOidcConfiguration.findUniqueOrThrow({ where: { providerConnectionId: id } });
    expect(await owner.authTransaction.findUniqueOrThrow({ where: { stateHash: state } })).toMatchObject({ purpose: "ACTIVATION_PROOF",
      subjectId: org.admin.subjectId, expectedProviderConnectionId: id, expectedConfigurationHash: configuration.configurationHash, consumedAt: null });
  });

  it("a passing proof is recorded on the configuration hash and the secret version, opens no session and keeps no identity", async () => {
    const id = await testingConnection(org);
    const counts = async () => [await owner.session.count({ where: { organizationId: org.organizationId } }),
      await owner.identityAccount.count({ where: { organizationId: org.organizationId } }), await owner.subject.count({ where: { organizationId: org.organizationId } })];
    const before = await counts();
    expect(await prove(org, id)).toBe("/dashboard?providerProof=passed");
    const [run] = await runsOf(id, "PROOF");
    const configuration = await owner.providerOidcConfiguration.findUniqueOrThrow({ where: { providerConnectionId: id } });
    const secret = await owner.providerSecretReference.findFirstOrThrow({ where: { providerConnectionId: id } });
    expect(run).toMatchObject({ outcome: "PASSED", reasonCode: "PROOF_PASSED", configurationHash: configuration.configurationHash, actorSubjectId: org.admin.subjectId,
      metadata: { issuerHost: "idp-proof.luxia-test.example", secretVersion: secret.activeVersion } });
    expect(JSON.stringify(run)).not.toMatch(/someone-at-the-provider|test-secret|eyJ/);
    expect(await counts()).toEqual(before);
    expect(h.cookieSet).not.toHaveBeenCalled();
    expect(await statusOf(id)).toBe("TESTING");
    const event = await owner.canonicalAdminAuditEvent.findFirstOrThrow({ where: { operation: "PROVIDER.CONNECTION.PROOF", metadata: { path: ["testRunId"], equals: run.id } } });
    expect(event).toMatchObject({ result: "SUCCESS", actorSubjectId: org.admin.subjectId });
  });

  it("a proof completes only in the session of the administrator who started it: no session, a member's, another admin's", async () => {
    const id = await testingConnection(org);
    for (const browser of [null, org.member, org.admin2]) {
      idp.reset();
      expect(await prove(org, id, { browser })).toBe("/dashboard?providerProof=failed");
      expect(tokenRequests()).toBe(0);
    }
    expect(await runsOf(id, "PROOF")).toEqual([]);
  });

  it("refusals before any call to the provider are journaled: member, DRAFT, ACTIVE, local, no secret", async () => {
    const draft = await testingConnection(org, { test: false });
    const noSecret = await testingConnection(org, { secret: false });
    const active = await testingConnection(org);
    const cases: Array<[string, Person, string, string]> = [
      ["member", org.member, await testingConnection(org), "FORBIDDEN"],
      ["DRAFT", org.admin, draft, "CONNECTION_PROOF_NOT_ALLOWED"],
      ["local", org.admin, org.local, "CONNECTION_PROOF_UNSUPPORTED"],
      ["no secret", org.admin, noSecret, "CONNECTION_SECRET_MISSING"],
      ["unknown", org.admin, randomUUID(), "PROVIDER_NOT_FOUND"],
    ];
    await activateWithEvidence(owner, org, active);
    cases.push(["ACTIVE", org.admin, active, "CONNECTION_PROOF_NOT_ALLOWED"]);
    idp.reset();
    for (const [name, who, target, expected] of cases) {
      const changeId = change();
      expect(await code(startConnectionProof(as(org, who), changeId, target)), name).toBe(expected);
      expect(await eventOf(changeId), name).toMatchObject({ result: "DENIED", metadata: { reasonCode: expected } });
    }
    expect(idp.requests).toEqual([]);
  });

  it("a wrong provider answer is a recorded FAILED proof with its safe reason, journaled as denied", async () => {
    const id = await testingConnection(org);
    idp.behaviour = {};
    const started = await startConnectionProof(as(org), change(), id);
    idp.behaviour = { aud: "someone-else" };
    const { code: authorizationCode, state } = idp.authorize(started.authorizationUrl, "someone-at-the-provider");
    h.sessionToken = org.admin.token;
    expect(where(await callback(request(`/auth/callback?${new URLSearchParams({ code: authorizationCode, state })}`)))).toBe("/dashboard?providerProof=failed");
    h.sessionToken = undefined;
    const [run] = await runsOf(id, "PROOF");
    expect(run).toMatchObject({ outcome: "FAILED", reasonCode: "OAUTH_JWT_CLAIM_COMPARISON_FAILED", metadata: { claim: "aud" } });
    const event = await owner.canonicalAdminAuditEvent.findFirstOrThrow({ where: { operation: "PROVIDER.CONNECTION.PROOF", metadata: { path: ["testRunId"], equals: run.id } } });
    expect(event.result).toBe("DENIED");
  });

  it("a configuration changed during the proof refuses it before the token request", async () => {
    const id = await testingConnection(org);
    const result = await prove(org, id, { beforeCallback: async () => {
      await owner.$transaction(async (tx) => { await lock(tx, org); await tx.providerOidcConfiguration.update({ where: { providerConnectionId: id }, data: { scopes: "openid email" } }); });
      idp.reset();
    } });
    expect(result).toBe("/dashboard?providerProof=failed");
    expect(tokenRequests()).toBe(0);
    expect(await runsOf(id, "PROOF")).toEqual([]);
    const denied = await owner.canonicalAdminAuditEvent.findFirstOrThrow({ where: { operation: "PROVIDER.CONNECTION.PROOF.DENIED", organizationId: org.organizationId }, orderBy: { occurredAt: "desc" } });
    expect(denied).toMatchObject({ metadata: { reasonCode: "CONNECTION_CONFIGURATION_CHANGED" } });
  });

  describe("first activation (TESTING to ACTIVE)", () => {
    const plan = (o: Org, id: string) => planConnectionTransition(as(o), change(), id, "ACTIVATE");
    const apply = (o: Org, id: string, digest: string) => applyConnectionTransition(as(o), change(), id, "ACTIVATE", digest);
    const evidenceOf = async (id: string) => {
      const configuration = await owner.providerOidcConfiguration.findUniqueOrThrow({ where: { providerConnectionId: id } });
      const secret = await owner.providerSecretReference.findFirstOrThrow({ where: { providerConnectionId: id, revokedAt: null } });
      return { organizationId: org.organizationId, providerConnectionId: id, configurationHash: configuration.configurationHash, secretVersion: secret.activeVersion };
    };

    it("refused without a proof, and journaled", async () => {
      const id = await testingConnection(org);
      const changeId = change();
      expect(await code(planConnectionTransition(as(org), changeId, id, "ACTIVATE"))).toBe("ACTIVATION_PROOF_REQUIRED");
      expect(await eventOf(changeId)).toMatchObject({ operation: "PROVIDER.CONNECTION.PLAN.DENIED", metadata: { reasonCode: "ACTIVATION_PROOF_REQUIRED" } });
      expect(await statusOf(id)).toBe("TESTING");
    });

    it("with a passing test and a passing proof on the current hash: plan, digest, apply, journal; then a linked person signs in", async () => {
      const own = await organization("s5b");
      const id = await testingConnection(own);
      expect(await prove(own, id)).toBe("/dashboard?providerProof=passed");
      const planned = await plan(own, id);
      const [discovery] = await runsOf(id, "DISCOVERY");
      const [proof] = await runsOf(id, "PROOF");
      expect(planned.activationEvidence).toMatchObject({ discoveryRunId: discovery.id, proofRunId: proof.id, proofActorSubjectId: own.admin.subjectId,
        configurationHash: proof.configurationHash });
      // Activated by another administrator than the one who proved it: recorded, not required.
      const changeId = change();
      const applied = await applyConnectionTransition(as(own, own.admin2), changeId, id, "ACTIVATE", planned.planDigest);
      expect(applied).toMatchObject({ from: "TESTING", to: "ACTIVE", activationEvidence: planned.activationEvidence });
      expect(await statusOf(id)).toBe("ACTIVE");
      // Prover and activating administrator are recorded separately (no four-eyes in F4 v1; kept for a future policy).
      expect(await eventOf(changeId)).toMatchObject({ operation: "PROVIDER.CONNECTION.ACTIVATE", result: "SUCCESS", actorSubjectId: own.admin2.subjectId,
        metadata: { from: "TESTING", to: "ACTIVE", discoveryRunId: discovery.id, proofRunId: proof.id,
          proofActorSubjectId: own.admin.subjectId, activationActorSubjectId: own.admin2.subjectId } });
      // The whole chain: DRAFT -> TESTING -> ACTIVE, then a linked person signs in through slice S4.
      const linked = await owner.subject.create({ data: { organizationId: own.organizationId, tenantId: own.tenantId, type: "HUMAN", name: "Linked", lifecycleState: "ACTIVE" } });
      await owner.identityAccount.create({ data: { organizationId: own.organizationId, tenantId: own.tenantId, subjectId: linked.id, providerConnectionId: id, externalObjectId: "linked-sub" } });
      const begun = await login(request(`/auth/login?org=${own.slug}&provider=oidc`));
      expect(begun.status).toBe(307);
      const { code: authorizationCode, state } = idp.authorize(begun.headers.get("location")!, "linked-sub");
      expect(where(await callback(request(`/auth/callback?${new URLSearchParams({ code: authorizationCode, state })}`)))).toBe("/dashboard");
      expect(await owner.session.count({ where: { subjectId: linked.id } })).toBe(1);
    });

    it("freshness on the database clock: a test older than 60 minutes or a proof older than 15 minutes does not count", async () => {
      const oldTest = await testingConnection(org);
      await prove(org, oldTest);
      const e1 = await evidenceOf(oldTest);
      await insertAgedRun(owner, { ...e1, kind: "DISCOVERY", outcome: "PASSED", minutesAgo: 61 });
      expect(await code(plan(org, oldTest))).toBe("ACTIVATION_TEST_REQUIRED");
      await insertAgedRun(owner, { ...e1, kind: "DISCOVERY", outcome: "PASSED", minutesAgo: 59 });
      expect((await plan(org, oldTest)).activationEvidence).toBeDefined();
      const oldProof = await testingConnection(org);
      const e2 = await evidenceOf(oldProof);
      await insertAgedRun(owner, { ...e2, kind: "PROOF", outcome: "PASSED", minutesAgo: 16 });
      expect(await code(plan(org, oldProof))).toBe("ACTIVATION_PROOF_REQUIRED");
      await insertAgedRun(owner, { ...e2, kind: "PROOF", outcome: "PASSED", minutesAgo: 14 });
      expect((await plan(org, oldProof)).activationEvidence).toBeDefined();
    });

    it("the evidence is read again at apply time: a proof failed after the plan refuses the activation", async () => {
      const id = await testingConnection(org);
      await prove(org, id);
      const planned = await plan(org, id);
      await insertAgedRun(owner, { ...(await evidenceOf(id)), kind: "PROOF", outcome: "FAILED", minutesAgo: 0 });
      expect(await code(apply(org, id, planned.planDigest))).toBe("ACTIVATION_PROOF_REQUIRED");
      expect(await statusOf(id)).toBe("TESTING");
    });

    it("the latest run is the database's order, not the timestamps: an older-dated failure inserted last decides", async () => {
      const id = await testingConnection(org);
      await prove(org, id);
      // A failure dated 5 minutes ago, recorded after the passing proof: by sequence it is the latest, so it refuses.
      await insertAgedRun(owner, { ...(await evidenceOf(id)), kind: "PROOF", outcome: "FAILED", minutesAgo: 5 });
      expect(await code(plan(org, id))).toBe("ACTIVATION_PROOF_REQUIRED");
      const runs = await owner.providerTestRun.findMany({ where: { providerConnectionId: id, kind: "PROOF" }, orderBy: { sequence: "asc" } });
      expect(runs.map((run) => run.outcome)).toEqual(["PASSED", "FAILED"]);
      expect(runs[1].occurredAt.getTime()).toBeLessThan(runs[0].occurredAt.getTime());
    });

    it("the latest run decides: a failed test or a failed proof after a passing one refuses", async () => {
      const failedTest = await testingConnection(org);
      await prove(org, failedTest);
      await testProviderConnection(as(org), change(), failedTest, { probe: async () => FAILED });
      expect(await code(plan(org, failedTest))).toBe("ACTIVATION_TEST_REQUIRED");
      const failedProof = await testingConnection(org);
      await prove(org, failedProof);
      const started = await startConnectionProof(as(org), change(), failedProof);
      idp.behaviour = { nonce: "other" };
      const again = idp.authorize(started.authorizationUrl, "x");
      h.sessionToken = org.admin.token;
      await callback(request(`/auth/callback?${new URLSearchParams({ code: again.code, state: again.state })}`));
      h.sessionToken = undefined;
      expect(await code(plan(org, failedProof))).toBe("ACTIVATION_PROOF_REQUIRED");
    });

    it("evidence on another configuration or another secret version does not count", async () => {
      const changedConfig = await testingConnection(org);
      await prove(org, changedConfig);
      await owner.$transaction(async (tx) => { await lock(tx, org); await tx.providerOidcConfiguration.update({ where: { providerConnectionId: changedConfig }, data: { scopes: "openid email" } }); });
      expect(await code(plan(org, changedConfig))).toBe("ACTIVATION_TEST_REQUIRED");
      const rotated = await testingConnection(org);
      await prove(org, rotated);
      const next = randomBytes(16).toString("hex");
      await owner.$transaction(async (tx) => {
        await lock(tx, org);
        await tx.providerSecretReference.updateMany({ where: { providerConnectionId: rotated, revokedAt: null }, data: { candidateVersion: next } });
        await tx.providerSecretReference.updateMany({ where: { providerConnectionId: rotated, revokedAt: null }, data: { activeVersion: next, candidateVersion: null } });
      });
      expect(await code(plan(org, rotated))).toBe("ACTIVATION_PROOF_SECRET_CHANGED");
    });

    it("a plan made stale by new evidence is refused (the digest covers the evidence)", async () => {
      const id = await testingConnection(org);
      await prove(org, id);
      const planned = await plan(org, id);
      await prove(org, id);
      expect(await code(apply(org, id, planned.planDigest))).toBe("CONNECTION_PLAN_STALE");
      expect(await statusOf(id)).toBe("TESTING");
    });

    it("the database refuses TESTING -> ACTIVE without valid evidence, for the owner and for app_user alike", async () => {
      const id = await testingConnection(org);
      const activate = (asOwner: boolean) => asOwner
        ? owner.$transaction(async (tx) => { await lock(tx, org); await tx.$executeRawUnsafe(`UPDATE "ProviderConnection" SET status = 'ACTIVE' WHERE id = '${id}'`); })
        : withTenantDb(as(org), async (tx) => { await lock(tx, org); await tx.$executeRawUnsafe(`UPDATE "ProviderConnection" SET status = 'ACTIVE' WHERE id = '${id}'`); });
      const reason = (promise: Promise<unknown>) => promise.then(() => "ACTIVATED", (error: unknown) => String((error as Error).message));
      for (const asOwner of [true, false]) expect(await reason(activate(asOwner))).toContain("PROVIDER_CONNECTION_ACTIVATION_EVIDENCE");
      // An old test, then an old proof: still refused. A generic connection can never be created other than DRAFT.
      const e = await evidenceOf(id);
      await insertAgedRun(owner, { ...e, kind: "DISCOVERY", outcome: "PASSED", minutesAgo: 61 });
      await insertAgedRun(owner, { ...e, kind: "PROOF", outcome: "PASSED", minutesAgo: 1 });
      expect(await reason(activate(true))).toContain("PROVIDER_CONNECTION_ACTIVATION_EVIDENCE");
      await insertAgedRun(owner, { ...e, kind: "DISCOVERY", outcome: "PASSED", minutesAgo: 1 });
      await insertAgedRun(owner, { ...e, kind: "PROOF", outcome: "PASSED", minutesAgo: 16 });
      expect(await reason(activate(true))).toContain("PROVIDER_CONNECTION_ACTIVATION_EVIDENCE");
      // A proof made with another secret version: refused.
      await insertAgedRun(owner, { ...e, kind: "PROOF", outcome: "PASSED", minutesAgo: 1, secretVersion: randomBytes(16).toString("hex") });
      expect(await reason(activate(true))).toContain("PROVIDER_CONNECTION_ACTIVATION_EVIDENCE");
      expect(await reason(owner.providerConnection.create({ data: { organizationId: org.organizationId, providerType: "OIDC_GENERIC", status: "ACTIVE",
        externalScopeId: `oidc-${randomUUID()}`, name: "Direct" } }))).toContain("PROVIDER_CONNECTION_ACTIVATION_EVIDENCE");
      // Valid evidence (fresh test, fresh proof with the live secret version): the same update goes through, as app_user.
      await insertAgedRun(owner, { ...e, kind: "PROOF", outcome: "PASSED", minutesAgo: 1 });
      expect(await reason(activate(false))).toBe("ACTIVATED");
      expect(await statusOf(id)).toBe("ACTIVE");
    });

    it("F2 regression: reactivating a DISABLED connection needs no evidence and keeps its digest", async () => {
      const id = await testingConnection(org);
      await prove(org, id);
      await apply(org, id, (await plan(org, id)).planDigest);
      const disable = await planConnectionTransition(as(org), change(), id, "DISABLE");
      await applyConnectionTransition(as(org), change(), id, "DISABLE", disable.planDigest);
      const reactivate = await planConnectionTransition(as(org), change(), id, "ACTIVATE");
      expect(reactivate.activationEvidence).toBeUndefined();
      const target = await owner.providerConnection.findUniqueOrThrow({ where: { id } });
      expect(reactivate.planDigest).toBe(connectionPlanDigest(as(org), { id, status: target.status, statusChangedAt: target.statusChangedAt }, "ACTIVATE"));
      expect(await applyConnectionTransition(as(org), change(), id, "ACTIVATE", reactivate.planDigest)).toMatchObject({ from: "DISABLED", to: "ACTIVE" });
    });
  });
});
