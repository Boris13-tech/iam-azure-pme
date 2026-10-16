import { randomBytes, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { GET as login } from "../../app/auth/login/route";
import { GET as callback } from "../../app/auth/callback/route";
import { AuthTransactionStore } from "../../lib/auth/auth-transaction-store";
import { SessionStore } from "../../lib/auth/session-store";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { OpenIdClientOidcGateway } from "../../lib/provider-adapters/implementations/oidc";
import { GenericOidcAuthenticationProvider, PrismaGenericOidcConfigResolver } from "../../lib/provider-adapters/implementations/oidc-generic";
import { TestIdp, guardedTestFetch, resolver, testSecretStore } from "../helpers/oidc-test-idp";
import { activateWithEvidence } from "../helpers/activation-evidence";

// F4, slice S4 on PostgreSQL: the real /auth/login and /auth/callback routes, as app_user, against providers simulated
// in memory behind the SSRF guard (stubbed DNS and transport; test secrets only, served by a stand-in for the vault).
// The owner (BYPASSRLS) sets up and reads what the runtime cannot. The Microsoft facade is mocked to prove its path is
// unchanged; the generic composition root is replaced to use the test providers.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const suffix = randomUUID().slice(0, 8);
const ORIGIN = "http://localhost:3000";
const SECRETS = { "akv://luxia-test-vault/oidc-a": "test-secret-a", "akv://luxia-test-vault/oidc-b": "test-secret-b", "akv://luxia-test-vault/oidc-k": "test-secret-k" };

// Several tests run complete round trips (login, provider, callback, session) five to ten times: more than vitest's 5 s.
vi.setConfig({ testTimeout: 60_000 });

const h = vi.hoisted(() => ({ provider: undefined as unknown, cookieSet: vi.fn(), entraBegin: vi.fn(), entraComplete: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: h.cookieSet }), headers: async () => ({ get: () => null }) }));
vi.mock("../../lib/provider-adapters/implementations/oidc-generic/runtime", () => ({ getGenericOidcAuthenticationProvider: () => h.provider }));
vi.mock("../../lib/auth/providers/entra", () => ({ beginEntraAuthentication: h.entraBegin, completeEntraAuthentication: h.entraComplete }));

let owner: PrismaClient;
let idpA: TestIdp;
let idpB: TestIdp;
type Org = { organizationId: string; tenantId: string; slug: string };
type Conn = { id: string; configurationHash: string };

async function organization(name: string): Promise<Org> {
  const organizationId = randomUUID(); const tenantId = randomUUID(); const slug = `${name}-${suffix}`;
  await owner.organization.create({ data: { id: organizationId, name, slug } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  return { organizationId, tenantId, slug };
}
const lock = (tx: Prisma.TransactionClient, org: Org) =>
  tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${org.organizationId}:${org.tenantId}`}, 0))::text`;
const setStatus = (org: Org, id: string, status: string) => owner.$transaction(async (tx) => {
  await lock(tx, org);
  await tx.$executeRawUnsafe(`UPDATE "ProviderConnection" SET status = '${status}' WHERE id = '${id}'`);
});
/** An OIDC_GENERIC connection with its configuration and secret reference, moved DRAFT -> TESTING -> ACTIVE unless told. */
async function genericConnection(org: Org, idp: TestIdp, clientId: string, locator: string, options: { activate?: boolean } = {}): Promise<Conn> {
  const connection = await owner.providerConnection.create({ data: {
    organizationId: org.organizationId, providerType: "OIDC_GENERIC", status: "DRAFT", externalScopeId: `oidc-${randomUUID()}`, name: "Generic IdP" } });
  await owner.providerConnectionTenantScope.create({ data: { organizationId: org.organizationId, tenantId: org.tenantId, providerConnectionId: connection.id } });
  await owner.$transaction(async (tx) => {
    await lock(tx, org);
    await tx.providerOidcConfiguration.create({ data: { organizationId: org.organizationId, providerConnectionId: connection.id, issuer: idp.issuer, clientId } });
    await tx.providerSecretReference.create({ data: { organizationId: org.organizationId, providerConnectionId: connection.id, purpose: "OIDC_CLIENT",
      store: "azure-key-vault", locator, activeVersion: randomBytes(16).toString("hex") } });
  });
  // Since S5 the database activates only on valid evidence (test fixture: a passing test and proof).
  if (options.activate ?? true) await activateWithEvidence(owner, org, connection.id);
  const configuration = await owner.providerOidcConfiguration.findUniqueOrThrow({ where: { providerConnectionId: connection.id } });
  return { id: connection.id, configurationHash: configuration.configurationHash };
}
async function person(org: Org, connectionId: string, externalObjectId: string, name = "Person") {
  const subject = await owner.subject.create({ data: { organizationId: org.organizationId, tenantId: org.tenantId, type: "HUMAN", name, lifecycleState: "ACTIVE" } });
  const account = await owner.identityAccount.create({ data: { organizationId: org.organizationId, tenantId: org.tenantId, subjectId: subject.id, providerConnectionId: connectionId, externalObjectId } });
  return { subjectId: subject.id, identityAccountId: account.id };
}

let ip = 0;
const request = (path: string) => new Request(`${ORIGIN}${path}`, { headers: { "x-real-ip": `198.51.100.${(ip++ % 200) + 1}-${suffix}`, "user-agent": `ua-${suffix}` } });
const location = (response: Response) => { const url = new URL(response.headers.get("location") ?? "", ORIGIN); return `${url.origin === ORIGIN ? "" : url.origin}${url.pathname}${url.search}`; };
const GENERIC_REFUSAL = "/login?error=signin";
/** Starts a generic sign-in for the organization; returns the provider's authorization URL and the state. */
async function begin(org: Org): Promise<{ authorizationUrl: string; state: string }> {
  const response = await login(request(`/auth/login?org=${org.slug}&provider=oidc`));
  expect(response.status).toBe(307);
  const authorizationUrl = response.headers.get("location")!;
  return { authorizationUrl, state: new URL(authorizationUrl).searchParams.get("state")! };
}
const back = (params: Record<string, string>) => callback(request(`/auth/callback?${new URLSearchParams(params)}`));
/** The whole round trip: begin, the person signs in at `idp` as `sub`, the browser comes back. */
async function signIn(org: Org, idp: TestIdp, sub: string, extra: Record<string, string> = {}) {
  const begun = await begin(org);
  const { code, state } = idp.authorize(begun.authorizationUrl, sub);
  return back({ code, state, ...extra });
}
const sessionsOf = (subjectId: string) => owner.session.findMany({ where: { subjectId }, orderBy: { createdAt: "asc" } });
const transactionOf = (state: string) => owner.authTransaction.findUniqueOrThrow({ where: { stateHash: state } });
const tokenRequests = (idp: TestIdp) => idp.requests.filter((r) => r.path === "/token").length;

describe.runIf(enabled)("F4 S4: generic OIDC sign-in and callback (PostgreSQL, app_user, real routes)", () => {
  let orgA: Org, orgB: Org, orgK: Org, orgM: Org;
  let connA: Conn, connB: Conn, connK: Conn, draftC: Conn;
  let member: { subjectId: string; identityAccountId: string };
  let entraConnectionId: string;
  const logs: string[] = [];
  let spies: MockInstance[] = [];

  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    idpA = await TestIdp.create("https://idp-a.luxia-test.example", { "luxia-a": SECRETS["akv://luxia-test-vault/oidc-a"], "luxia-k": SECRETS["akv://luxia-test-vault/oidc-k"] });
    idpB = await TestIdp.create("https://idp-b.luxia-test.example", { "luxia-b": SECRETS["akv://luxia-test-vault/oidc-b"] });
    h.provider = new GenericOidcAuthenticationProvider(new PrismaGenericOidcConfigResolver(),
      new OpenIdClientOidcGateway(testSecretStore(SECRETS), undefined, guardedTestFetch([idpA, idpB])), resolver());
    orgA = await organization("s4a"); orgB = await organization("s4b"); orgK = await organization("s4k"); orgM = await organization("s4m");
    connA = await genericConnection(orgA, idpA, "luxia-a", "akv://luxia-test-vault/oidc-a");
    connB = await genericConnection(orgB, idpB, "luxia-b", "akv://luxia-test-vault/oidc-b");
    connK = await genericConnection(orgK, idpA, "luxia-k", "akv://luxia-test-vault/oidc-k");
    // A second generic connection in organization A, never activated: an account on it is "linked to another connection".
    draftC = await genericConnection(orgA, idpB, "luxia-b", "akv://luxia-test-vault/oidc-b", { activate: false });
    member = await person(orgA, connA.id, "sub-member", "Member");
    await person(orgA, draftC.id, "sub-on-c");
    await person(orgB, connB.id, "sub-b");
    // An account whose external id looks like an e-mail: it must never match a token's e-mail claim.
    await person(orgA, connA.id, "person@example.test", "Email-shaped");
    const entra = await owner.providerConnection.create({ data: { organizationId: orgA.organizationId, providerType: "MICROSOFT_ENTRA", externalScopeId: "tid-s4", name: "Entra" } });
    await owner.providerConnectionTenantScope.create({ data: { organizationId: orgA.organizationId, tenantId: orgA.tenantId, providerConnectionId: entra.id } });
    await person(orgA, entra.id, "sub-on-entra");
    const m = await owner.providerConnection.create({ data: { organizationId: orgM.organizationId, providerType: "MICROSOFT_ENTRA", externalScopeId: "tid-m", name: "Entra" } });
    await owner.providerConnectionTenantScope.create({ data: { organizationId: orgM.organizationId, tenantId: orgM.tenantId, providerConnectionId: m.id } });
    entraConnectionId = m.id;
    await person(orgM, m.id, "oid-m");
  }, 180_000);
  beforeEach(() => {
    idpA.reset(); idpB.reset(); h.cookieSet.mockClear(); h.entraBegin.mockReset(); h.entraComplete.mockReset(); logs.length = 0;
    spies = (["warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); }));
  });
  afterEach(() => { for (const spy of spies) spy.mockRestore(); });
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("happy path: login binds connection + SIGN_IN + configuration; the callback opens a session with safe VERIFIED evidence", async () => {
    const begun = await begin(orgA);
    expect(new URL(begun.authorizationUrl).origin).toBe(idpA.issuer);
    expect(await transactionOf(begun.state)).toMatchObject({ purpose: "SIGN_IN", subjectId: null, expectedProviderConnectionId: connA.id,
      expectedOrganizationId: orgA.organizationId, expectedTenantId: orgA.tenantId, expectedConfigurationHash: connA.configurationHash, consumedAt: null });
    const { code, state } = idpA.authorize(begun.authorizationUrl, "sub-member");
    const before = (await sessionsOf(member.subjectId)).length;
    const response = await back({ code, state });
    expect(response.status).toBe(307);
    expect(location(response)).toBe("/dashboard");
    expect(h.cookieSet).toHaveBeenCalledWith("luxia_session", expect.any(String), expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }));
    expect((await sessionsOf(member.subjectId)).length).toBe(before + 1);
    expect((await transactionOf(state)).consumedAt).not.toBeNull();
    const [evidence] = await owner.authenticationEvidence.findMany({ where: { identityAccountId: member.identityAccountId }, orderBy: { recordedAt: "desc" }, take: 1 });
    expect(evidence).toMatchObject({ method: "FEDERATED_OIDC", outcome: "VERIFIED", reasonCode: "OIDC_GENERIC_VERIFIED", source: "EXTERNAL_PROVIDER",
      assuranceProfile: "OIDC_GENERIC_PROVIDER_ATTESTED", assuranceLevel: "LOW", userVerification: "PROVIDER_ASSERTED", phishingResistant: false,
      providerConnectionId: connA.id, subjectId: member.subjectId });
    expect(JSON.stringify(evidence)).not.toMatch(/sub-member|test-secret|test-access-token|198\.51\.100|ua-/);
    // Client authentication: client_secret_basic, the F4-5 default.
    expect(idpA.requests.filter((r) => r.path === "/token").map((r) => r.clientAuth)).toEqual(["client_secret_basic"]);
  });

  it("the callback takes connection, scope and configuration from the transaction only, and refuses a changed configuration", async () => {
    // A transaction bound to another configuration hash (as if the configuration had changed meanwhile).
    const begun = await begin(orgA);
    const { code, state } = idpA.authorize(begun.authorizationUrl, "sub-member");
    await owner.authTransaction.update({ where: { stateHash: state }, data: { expectedConfigurationHash: "f".repeat(64) } });
    idpA.reset();
    const response = await back({ code, state, org: orgB.slug, providerConnectionId: connB.id, issuer: idpB.issuer });
    expect(response.status).toBe(303);
    expect(location(response)).toBe(GENERIC_REFUSAL);
    expect(idpA.requests).toEqual([]);
    expect(idpB.requests).toEqual([]);
    // No configuration binding at all: refused the same way, before any request.
    const second = await begin(orgA);
    const again = idpA.authorize(second.authorizationUrl, "sub-member");
    await owner.authTransaction.update({ where: { stateHash: again.state }, data: { expectedConfigurationHash: null } });
    idpA.reset();
    expect(location(await back({ code: again.code, state: again.state }))).toBe(GENERIC_REFUSAL);
    expect(idpA.requests).toEqual([]);
    expect(logs.join("\n")).toContain("CONFIGURATION_BINDING_MISSING");
  });

  it("state: an unknown, expired or replayed state is refused with the shared generic answer, and nothing reaches the provider", async () => {
    expect((await back({ code: "x", state: "unknown-state" })).status).toBe(400);
    const expired = await begin(orgA);
    const late = idpA.authorize(expired.authorizationUrl, "sub-member");
    await owner.authTransaction.update({ where: { stateHash: expired.state }, data: { expiresAt: new Date(Date.now() - 1000) } });
    idpA.reset();
    expect((await back({ code: late.code, state: late.state })).status).toBe(400);
    expect(tokenRequests(idpA)).toBe(0);
    const used = await signIn(orgA, idpA, "sub-member");
    expect(used.status).toBe(307);
    const replayState = (await owner.authTransaction.findFirstOrThrow({ where: { expectedProviderConnectionId: connA.id, consumedAt: { not: null } }, orderBy: { consumedAt: "desc" } })).stateHash;
    idpA.reset();
    const replay = await back({ code: "any", state: replayState });
    expect(replay.status).toBe(400);
    expect(tokenRequests(idpA)).toBe(0);
  });

  it("single use: concurrent consumptions of one transaction have exactly one winner", async () => {
    for (let round = 0; round < 5; round++) {
      const { state } = await begin(orgA);
      const results = await Promise.all([1, 2, 3, 4].map(() => AuthTransactionStore.consumeTransaction(state)));
      expect(results.filter(Boolean)).toHaveLength(1);
    }
  });

  it("PKCE: a callback completed with another round trip's verifier is refused (the provider rejects the code)", async () => {
    const first = await begin(orgA);
    const second = await begin(orgA);
    const { code } = idpA.authorize(first.authorizationUrl, "sub-member");
    // The code of the first round trip, brought back with the second one's state: the second verifier does not match.
    const response = await back({ code, state: second.state });
    expect(location(response)).toBe(GENERIC_REFUSAL);
    expect(h.cookieSet).not.toHaveBeenCalled();
  });

  it("purpose: no other purpose ever signs in; each is consumed, answered without a session, before any call to the provider", async () => {
    // LINK (slice S6) gets the generic sign-in refusal; ACTIVATION_PROOF (slice S5) goes to the proof, which needs the
    // starting administrator's session in this browser (none here) and never opens one.
    for (const [purpose, answer] of [["LINK", GENERIC_REFUSAL], ["ACTIVATION_PROOF", "/dashboard?providerProof=failed"]]) {
      const state = `purpose-${purpose}-${randomUUID()}`;
      await owner.authTransaction.create({ data: { id: randomUUID().replace(/-/g, ""), stateHash: state, nonce: "n", codeVerifier: "v",
        expectedOrganizationId: orgA.organizationId, expectedTenantId: orgA.tenantId, expectedProviderConnectionId: connA.id,
        purpose, subjectId: member.subjectId, expectedConfigurationHash: connA.configurationHash, expiresAt: new Date(Date.now() + 600_000) } });
      const response = await back({ code: "c", state });
      expect(response.status).toBe(303);
      expect(location(response)).toBe(answer);
      expect((await transactionOf(state)).consumedAt).not.toBeNull();
    }
    expect(idpA.requests).toEqual([]);
    expect(h.cookieSet).not.toHaveBeenCalled();
  });

  it("kill switch: a DISABLED or QUARANTINED connection starts no sign-in, and one disabled mid-flight completes none", async () => {
    const k = await person(orgK, connK.id, "sub-k");
    // Mid-flight: started while ACTIVE, disabled before the browser comes back.
    const begun = await begin(orgK);
    const { code, state } = idpA.authorize(begun.authorizationUrl, "sub-k");
    await setStatus(orgK, connK.id, "DISABLED");
    idpA.reset();
    expect(location(await back({ code, state }))).toBe(GENERIC_REFUSAL);
    expect(tokenRequests(idpA)).toBe(0);
    // DISABLED, then QUARANTINED: the login itself refuses, identically.
    expect(location(await login(request(`/auth/login?org=${orgK.slug}&provider=oidc`)))).toBe(GENERIC_REFUSAL);
    await setStatus(orgK, connK.id, "QUARANTINED");
    expect(location(await login(request(`/auth/login?org=${orgK.slug}&provider=oidc`)))).toBe(GENERIC_REFUSAL);
    expect(await owner.session.count({ where: { identityAccountId: k.identityAccountId } })).toBe(0);
    expect(idpA.requests).toEqual([]);
  });

  it("identity by (connection, sub) only: unknown, linked elsewhere, e-mail lookalike: one identical generic refusal, nothing created", async () => {
    const counts = async () => [await owner.subject.count(), await owner.identityAccount.count(), await owner.session.count(), await owner.authenticationEvidence.count()];
    const before = await counts();
    const answers: string[] = [];
    for (const [sub, extra] of [
      ["sub-never-seen", {}],
      ["sub-on-c", {}],                 // linked to another connection of the same organization
      ["sub-on-entra", {}],             // linked to the organization's Microsoft connection
      ["sub-b", {}],                    // linked in another organization
      ["sub-unknown-2", { email: "person@example.test", preferred_username: "person@example.test", upn: "person@example.test", name: "Member" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const begun = await begin(orgA);
      idpA.behaviour = { extraClaims: extra };
      const { code, state } = idpA.authorize(begun.authorizationUrl, sub);
      const response = await back({ code, state });
      answers.push(`${response.status} ${location(response)} ${await response.text()}`);
      idpA.behaviour = {};
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe(`303 ${GENERIC_REFUSAL} `);
    // No just-in-time account, no subject, no session, and no evidence for an unknown identity.
    expect(await counts()).toEqual(before);
    expect(h.cookieSet).not.toHaveBeenCalled();
    // The journal line says why, with constants only: never the subject, a claim value, an address or the user agent.
    const journal = logs.join("\n");
    expect(journal).toContain("IDENTITY_NOT_LINKED");
    expect(journal).not.toMatch(/sub-never-seen|sub-on-c|sub-on-entra|sub-b|person@example|198\.51\.100|ua-/);
  });

  it("claims never become authority: roles, groups, entitlements or another organization in the token change nothing", async () => {
    const authority = async () => [await owner.assignment.count({ where: { organizationId: orgA.organizationId } }),
      await owner.entitlement.count({ where: { organizationId: orgA.organizationId } }),
      await owner.subject.findUniqueOrThrow({ where: { id: member.subjectId } })];
    const before = await authority();
    const begun = await begin(orgA);
    idpA.behaviour = { extraClaims: { roles: ["LUXIA_ORG_ADMIN", "admin"], groups: ["Administrators"], entitlements: ["providers.manage", "*"],
      organization_id: orgB.organizationId, tenant_id: orgB.tenantId, luxia_admin: true, email: "admin@example.test" } };
    const { code, state } = idpA.authorize(begun.authorizationUrl, "sub-member");
    const response = await back({ code, state });
    expect(response.status).toBe(307);
    expect(await authority()).toEqual(before);
    const [session] = (await sessionsOf(member.subjectId)).slice(-1);
    expect(session).toMatchObject({ organizationId: orgA.organizationId, tenantId: orgA.tenantId, subjectId: member.subjectId, identityAccountId: member.identityAccountId });
  });

  it("a provider outage never touches an existing LUXIA session: the new sign-in is refused as unavailable, the session stays valid", async () => {
    const ok = await signIn(orgA, idpA, "sub-member");
    expect(ok.status).toBe(307);
    const rawToken = h.cookieSet.mock.calls.at(-1)![1] as string;
    const [existing] = (await sessionsOf(member.subjectId)).slice(-1);
    h.cookieSet.mockClear();
    // Outage at the start of a new sign-in, then in the middle of one.
    idpA.behaviour = { down: true };
    expect(location(await login(request(`/auth/login?org=${orgA.slug}&provider=oidc`)))).toBe("/login?error=unavailable");
    idpA.behaviour = {};
    const begun = await begin(orgA);
    const { code, state } = idpA.authorize(begun.authorizationUrl, "sub-member");
    idpA.behaviour = { down: true };
    expect(location(await back({ code, state }))).toBe("/login?error=unavailable");
    idpA.behaviour = {};
    const third = await begin(orgA);
    const late = idpA.authorize(third.authorizationUrl, "sub-member");
    idpA.behaviour = { tokenStatus: 503 };
    expect(location(await back({ code: late.code, state: late.state }))).toBe("/login?error=unavailable");
    idpA.behaviour = {};
    expect(h.cookieSet).not.toHaveBeenCalled();
    const after = await owner.session.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after).toMatchObject({ revokedAt: null, expiresAt: existing.expiresAt, subjectId: member.subjectId });
    expect(await SessionStore.getSession(rawToken)).toMatchObject({ subjectId: member.subjectId });
  });

  it("a known identity that may not sign in gets the generic answer, with a REJECTED evidence carrying the safe reason", async () => {
    const blocked = await person(orgA, connA.id, "sub-blocked", "Blocked");
    await owner.identityAccount.update({ where: { id: blocked.identityAccountId }, data: { status: "DISABLED", disabledAt: new Date() } });
    const response = await signIn(orgA, idpA, "sub-blocked");
    expect(location(response)).toBe(GENERIC_REFUSAL);
    const evidence = await owner.authenticationEvidence.findMany({ where: { identityAccountId: blocked.identityAccountId } });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ outcome: "REJECTED", reasonCode: "IDENTITY_ACCOUNT_DISABLED", assuranceProfile: "OIDC_GENERIC_PROVIDER_ATTESTED" });
    expect(await owner.session.count({ where: { identityAccountId: blocked.identityAccountId } })).toBe(0);
  });

  it("R8 through the routes: a bad token, a callback naming another issuer, every refusal is the generic answer and no session", async () => {
    for (const behaviour of [{ iss: "https://evil.luxia-test.example" }, { aud: "someone-else" }, { otherKey: true }, { alg: "none" as const },
      { alg: "PS256" as const }, { expired: true }, { iatOffset: 120 }, { nonce: "other" }, { nonce: null }]) {
      const begun = await begin(orgA);
      idpA.behaviour = behaviour;
      const { code, state } = idpA.authorize(begun.authorizationUrl, "sub-member");
      expect(location(await back({ code, state })), JSON.stringify(behaviour)).toBe(GENERIC_REFUSAL);
      idpA.behaviour = {};
    }
    const begun = await begin(orgA);
    const { code, state } = idpA.authorize(begun.authorizationUrl, "sub-member");
    idpA.reset();
    expect(location(await back({ code, state, iss: idpB.issuer }))).toBe(GENERIC_REFUSAL);
    expect(tokenRequests(idpA)).toBe(0);
    expect(h.cookieSet).not.toHaveBeenCalled();
    expect(logs.join("\n")).not.toMatch(/eyJ|test-secret|test-access-token/);
  });

  describe("mix-up A -> B between two OIDC connections", () => {
    it("connection A's state with a code from provider B (and the reverse) is refused; B's linked person never signs in", async () => {
      const sessionsB = await owner.session.count({ where: { organizationId: orgB.organizationId } });
      const atA = await begin(orgA);
      const atB = await begin(orgB);
      const fromB = idpB.authorize(atB.authorizationUrl, "sub-b");
      const fromA = idpA.authorize(atA.authorizationUrl, "sub-member");
      // Only the request logs are cleared: both codes stay valid at the provider that issued them.
      const clearLogs = () => { idpA.requests.length = 0; idpB.requests.length = 0; };
      clearLogs();
      expect(location(await back({ code: fromB.code, state: atA.state }))).toBe(GENERIC_REFUSAL);
      // A's round trip goes to A's token endpoint only (which refuses B's code): B is never asked for a token.
      expect([tokenRequests(idpA), tokenRequests(idpB)]).toEqual([1, 0]);
      clearLogs();
      expect(location(await back({ code: fromA.code, state: atB.state }))).toBe(GENERIC_REFUSAL);
      // The reverse: B's round trip goes to B's token endpoint only; A is never asked.
      expect([tokenRequests(idpA), tokenRequests(idpB)]).toEqual([0, 1]);
      expect(await owner.session.count({ where: { organizationId: orgB.organizationId } })).toBe(sessionsB);
      expect(h.cookieSet).not.toHaveBeenCalled();
    });

    it("provider A answering with a token issued and signed by provider B is refused", async () => {
      const begun = await begin(orgA);
      idpA.behaviour = { tokenFrom: idpB, sub: "sub-b" };
      const { code, state } = idpA.authorize(begun.authorizationUrl, "sub-b");
      expect(location(await back({ code, state }))).toBe(GENERIC_REFUSAL);
    });

    it("an organization with two ACTIVE generic connections starts no sign-in (no implicit choice)", async () => {
      const second = await genericConnection(orgB, idpA, "luxia-a", "akv://luxia-test-vault/oidc-a");
      expect(location(await login(request(`/auth/login?org=${orgB.slug}&provider=oidc`)))).toBe(GENERIC_REFUSAL);
      await setStatus(orgB, second.id, "DISABLED");
      expect((await login(request(`/auth/login?org=${orgB.slug}&provider=oidc`))).status).toBe(307);
    });
  });

  describe("Microsoft regression (F1 path unchanged)", () => {
    const challenge = (state: string) => ({ transactionId: state, kind: "REDIRECT", redirectUrl: `https://login.example.test/authorize?state=${state}`,
      continuation: { nonce: `nonce-${state}`, codeVerifier: `verifier-${state}` }, expiresAt: new Date(Date.now() + 600_000).toISOString() });

    it("without provider (and with provider=microsoft) the login starts Microsoft exactly as before, with no configuration binding", async () => {
      for (const query of [`org=${orgM.slug}`, `org=${orgM.slug}&provider=microsoft`]) {
        const state = `ms-${randomUUID()}`;
        h.entraBegin.mockResolvedValueOnce(challenge(state));
        const response = await login(request(`/auth/login?${query}&returnTo=/dashboard/settings`));
        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe(`https://login.example.test/authorize?state=${state}`);
        expect(h.entraBegin).toHaveBeenLastCalledWith({ providerConnection: expect.objectContaining({ id: entraConnectionId, providerType: "MICROSOFT_ENTRA" }),
          tenantId: orgM.tenantId, returnTo: "/dashboard/settings" });
        expect(await transactionOf(state)).toMatchObject({ purpose: "SIGN_IN", subjectId: null, expectedConfigurationHash: null,
          expectedProviderConnectionId: entraConnectionId, nonce: `nonce-${state}`, codeVerifier: `verifier-${state}`, returnTo: "/dashboard/settings" });
      }
      expect(location(await login(request(`/auth/login?org=${orgM.slug}&provider=other`)))).toBe(GENERIC_REFUSAL);
      expect(location(await login(request(`/auth/login?org=${orgM.slug}&provider=oidc`)))).toBe(GENERIC_REFUSAL);
      expect(idpA.requests).toEqual([]);
    });

    it("the Microsoft callback completes through its own facade with the same arguments, the same evidence and the same answers", async () => {
      const state = `ms-${randomUUID()}`;
      h.entraBegin.mockResolvedValueOnce(challenge(state));
      await login(request(`/auth/login?org=${orgM.slug}`));
      h.entraComplete.mockResolvedValueOnce({ identity: { externalObjectId: "oid-m" }, assuranceLevel: "ENTRA_OIDC", authenticatedAt: new Date().toISOString(), attributes: {} });
      const response = await back({ code: "ms-code", state });
      expect(response.status).toBe(307);
      expect(location(response)).toBe("/dashboard");
      expect(h.entraComplete).toHaveBeenCalledWith({ providerConnection: expect.objectContaining({ id: entraConnectionId }), tenantId: orgM.tenantId,
        state, nonce: `nonce-${state}`, codeVerifier: `verifier-${state}`, currentUrl: `${ORIGIN}/auth/callback?code=ms-code&state=${encodeURIComponent(state)}` });
      const [evidence] = await owner.authenticationEvidence.findMany({ where: { organizationId: orgM.organizationId }, orderBy: { recordedAt: "desc" }, take: 1 });
      expect(evidence).toMatchObject({ outcome: "VERIFIED", reasonCode: "ENTRA_OIDC_VERIFIED", assuranceProfile: "ENTRA_OIDC_PROVIDER_ATTESTED" });
      // An unknown Microsoft identity keeps its existing answer.
      const unknown = `ms-${randomUUID()}`;
      h.entraBegin.mockResolvedValueOnce(challenge(unknown));
      await login(request(`/auth/login?org=${orgM.slug}`));
      h.entraComplete.mockResolvedValueOnce({ identity: { externalObjectId: "oid-unknown" }, assuranceLevel: "ENTRA_OIDC", authenticatedAt: new Date().toISOString(), attributes: {} });
      const refused = await back({ code: "ms-code", state: unknown });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "IDENTITY_NOT_ONBOARDED" });
      expect(idpA.requests).toEqual([]);
    });
  });
});
