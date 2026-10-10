import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { allowRequest } from "../../lib/security/rate-limit";

// Customer Self-Onboarding v1, step 2: organization-aware sign-in and anti-enumeration, exercised
// through the real route handlers as app_user on PostgreSQL. Microsoft itself is not called: only
// the adapter's redirect builder is replaced, everything before it is real.
vi.mock("../../lib/auth/providers/entra", () => ({
  beginEntraAuthentication: vi.fn(async () => ({
    transactionId: `state-${randomUUID()}`, kind: "REDIRECT",
    redirectUrl: "https://login.microsoftonline.com/test/oauth2/v2.0/authorize?state=x",
    continuation: { nonce: "nonce-test", codeVerifier: "verifier-test" },
  })),
}));
import { POST as begin } from "../../app/api/auth/local/begin/route";
import { POST as complete } from "../../app/api/auth/local/complete/route";
import { GET as entraLogin } from "../../app/auth/login/route";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const suffix = randomUUID().slice(0, 8);
let owner: PrismaClient;
let ipCounter = 0;
const ip = () => `198.51.100.${(++ipCounter % 250) + 1}-${suffix}`;

type Org = { slug: string; organizationId: string; tenantId: string; local?: string; entra?: string[] };
async function organization(name: string, options: { local?: boolean; entra?: number; tenants?: number } = {}): Promise<Org> {
  const org: Org = { slug: `${name}-${suffix}`, organizationId: randomUUID(), tenantId: randomUUID() };
  await owner.organization.create({ data: { id: org.organizationId, name, slug: org.slug } });
  await owner.tenant.create({ data: { id: org.tenantId, organizationId: org.organizationId, name: "Production" } });
  for (let i = 1; i < (options.tenants ?? 1); i++) await owner.tenant.create({ data: { organizationId: org.organizationId, name: `Extra ${i}` } });
  const connect = async (providerType: "LUXIA_LOCAL" | "MICROSOFT_ENTRA", index: number) => {
    const connection = await owner.providerConnection.create({ data: { organizationId: org.organizationId, providerType, externalScopeId: `${providerType}-${index}-${org.organizationId}`, name: providerType } });
    await owner.providerConnectionTenantScope.create({ data: { organizationId: org.organizationId, tenantId: org.tenantId, providerConnectionId: connection.id } });
    return connection.id;
  };
  if (options.local) org.local = await connect("LUXIA_LOCAL", 0);
  org.entra = [];
  for (let i = 0; i < (options.entra ?? 0); i++) org.entra.push(await connect("MICROSOFT_ENTRA", i));
  return org;
}
async function person(org: Org, principalName: string, credentialIds: string[], status: "ACTIVE" | "LOCKED" = "ACTIVE") {
  const subjectId = randomUUID(), accountId = randomUUID();
  await owner.subject.create({ data: { id: subjectId, organizationId: org.organizationId, tenantId: org.tenantId, type: "HUMAN", name: principalName } });
  await owner.identityAccount.create({ data: { id: accountId, organizationId: org.organizationId, tenantId: org.tenantId, subjectId, providerConnectionId: org.local!, externalObjectId: randomUUID() } });
  await owner.localIdentity.create({ data: { organizationId: org.organizationId, tenantId: org.tenantId, identityAccountId: accountId, principalName, status,
    ...(status === "LOCKED" ? { lockedUntil: new Date(Date.now() + 3_600_000) } : {}) } });
  for (const credentialId of credentialIds)
    await owner.localAuthenticator.create({ data: { organizationId: org.organizationId, tenantId: org.tenantId, identityAccountId: accountId, type: "PASSKEY",
      credentialId, publicKey: "-----BEGIN PUBLIC KEY-----test", relyingPartyId: "localhost", allowedOrigin: "http://localhost:3000",
      credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY", algorithmId: "WEBAUTHN_ES256" } });
  return { subjectId, accountId };
}
const post = (handler: (request: Request) => Promise<Response>, path: string, body: unknown, address = ip()) =>
  handler(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": address }, body: JSON.stringify(body) }));
const beginJson = async (body: unknown) => {
  const startedAt = Date.now();
  const response = await post(begin, "/api/auth/local/begin", body);
  return { status: response.status, body: await response.json(), ms: Date.now() - startedAt };
};
const shape = (value: Record<string, unknown>) => ({
  keys: Object.keys(value).sort(),
  transactionId: /^[0-9a-f-]{36}$/.test(String(value.transactionId)),
  challenge: String(value.challenge).length,
  rpId: value.rpId,
  credentials: Array.isArray(value.allowCredentials) && value.allowCredentials.every((id: unknown) => typeof id === "string" && id.length === 43),
});
const credential = () => Buffer.from(randomUUID() + randomUUID()).subarray(0, 32).toString("base64url");

describe.runIf(enabled)("Organization-aware sign-in and anti-enumeration (app_user, PostgreSQL)", () => {
  let a: Org, b: Org, twoEntra: Org, twoTenants: Org;
  const aliceCredential = credential();
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    a = await organization("alpha", { local: true, entra: 1 });
    b = await organization("bravo", { local: true });
    twoEntra = await organization("charlie", { local: true, entra: 2 });
    twoTenants = await organization("delta", { local: true, entra: 1, tenants: 2 });
    await person(a, "alice", [aliceCredential]);
    await person(a, "locked", [credential()], "LOCKED");
    await person(a, "nokey", []);
    await person(b, "bob", [credential()]);
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("a real and every decoy answer have the same status, shape and comparable timing", async () => {
    const real = await beginJson({ organization: a.slug, principalName: "Alice " });
    expect(real.status).toBe(200);
    expect(real.body.allowCredentials).toEqual([aliceCredential]);
    const decoys = await Promise.all([
      beginJson({ organization: a.slug, principalName: "nobody" }),          // unknown identifier
      beginJson({ organization: `zulu-${suffix}`, principalName: "alice" }), // unknown organization
      beginJson({ organization: b.slug, principalName: "alice" }),           // identifier of another organization
      beginJson({ organization: a.slug, principalName: "locked" }),          // locked identity
      beginJson({ organization: a.slug, principalName: "nokey" }),           // identity without a passkey
    ]);
    for (const decoy of decoys) {
      expect(decoy.status).toBe(200);
      expect(shape(decoy.body)).toEqual({ ...shape(real.body), credentials: true });
      expect(decoy.body.allowCredentials.length).toBeGreaterThanOrEqual(1);
      expect(decoy.body.allowCredentials.length).toBeLessThanOrEqual(2);
      expect(decoy.ms).toBeGreaterThanOrEqual(380);
    }
    expect(real.ms).toBeGreaterThanOrEqual(380);
    expect(JSON.stringify(decoys)).not.toMatch(/alpha|bravo|Alice|organizationId|tenantId|externalObjectId/i);
  });

  it("decoys are stable per identifier (no tell from repeating), challenges are always fresh", async () => {
    const first = await beginJson({ organization: `zulu-${suffix}`, principalName: "someone" });
    const second = await beginJson({ organization: `zulu-${suffix}`, principalName: "someone" });
    const other = await beginJson({ organization: `zulu-${suffix}`, principalName: "someone-else" });
    expect(second.body.allowCredentials).toEqual(first.body.allowCredentials);
    expect(other.body.allowCredentials).not.toEqual(first.body.allowCredentials);
    expect(second.body.challenge).not.toBe(first.body.challenge);
    expect(second.body.transactionId).not.toBe(first.body.transactionId);
  });

  it("only a real identity gets a stored challenge; browser-supplied tenant or connection ids are ignored", async () => {
    const count = () => owner.localAuthChallenge.count({ where: { organizationId: { in: [a.organizationId, b.organizationId] } } });
    const before = await count();
    await beginJson({ organization: b.slug, principalName: "alice", providerConnectionId: a.local, tenantId: a.tenantId });
    expect(await count()).toBe(before);
    await beginJson({ organization: a.slug, principalName: "alice" });
    expect(await count()).toBe(before + 1);
  });

  it("format errors are the only other answer, independent of existence", async () => {
    for (const body of [{ organization: "Bad Slug", principalName: "x" }, { organization: "admin", principalName: "x" }, { organization: a.slug }, null]) {
      const response = await post(begin, "/api/auth/local/begin", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "INVALID_REQUEST" });
    }
  });

  it("completion refuses with one generic answer: decoy transaction, bad signature, or another organization", async () => {
    const decoy = await beginJson({ organization: `zulu-${suffix}`, principalName: "alice" });
    const real = await beginJson({ organization: a.slug, principalName: "alice" });
    const attempt = (organization: string, started: { body: Record<string, string> }) => post(complete, "/api/auth/local/complete", {
      organization, transactionId: started.body.transactionId, challenge: started.body.challenge, credentialId: aliceCredential,
      clientDataJSON: "e30", authenticatorData: "AAAA", signature: "AAAA",
    });
    const answers = [
      await attempt(`zulu-${suffix}`, decoy),
      await attempt(a.slug, decoy),
      await attempt(b.slug, real),   // a real transaction of A presented under B
      await attempt(a.slug, real),   // bad signature
    ];
    for (const response of answers) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "LOCAL_AUTHENTICATION_FAILED" });
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(await owner.session.count({ where: { organizationId: { in: [a.organizationId, b.organizationId] } } })).toBe(0);
  });

  it("requirement 3: sign-in is rate limited per client, with the same answer for every organization", async () => {
    const address = ip();
    let allowed = 0;
    while (await allowRequest("login-begin", `ip:${address}`) && allowed < 400) allowed++;
    expect(allowed).toBeLessThanOrEqual(300);
    for (const organization of [a.slug, `zulu-${suffix}`]) {
      const response = await post(begin, "/api/auth/local/begin", { organization, principalName: "alice" }, address);
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "RATE_LIMITED" });
    }
  });

  it("requirement 14: Microsoft sign-in uses exactly one connection of the organization's single tenant, never a first result", async () => {
    const go = (org: string | null, extra = "") => entraLogin(new Request(`http://localhost:3000/auth/login${org === null ? "" : `?org=${encodeURIComponent(org)}`}${extra}`, { headers: { "x-real-ip": ip() } }));
    for (const org of [`zulu-${suffix}`, b.slug, twoEntra.slug, twoTenants.slug, "Bad Slug", null]) {
      const response = await go(org);
      expect(response.status, String(org)).toBe(303);
      expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=signin");
    }
    const ok = await go(a.slug, "&returnTo=https%3A%2F%2Fevil.example%2F");
    expect(ok.status).toBe(307);
    expect(ok.headers.get("location")).toMatch(/^https:\/\/login\.microsoftonline\.com\//);
    const transaction = await owner.authTransaction.findFirst({ where: { expectedOrganizationId: a.organizationId }, orderBy: { createdAt: "desc" } });
    expect(transaction).toMatchObject({ expectedTenantId: a.tenantId, expectedProviderConnectionId: a.entra![0], returnTo: "/dashboard" });
  });
});
