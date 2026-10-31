import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { LUXIA_ORG_ADMIN_V1 } from "../../lib/auth/native-role-catalog";
import { GOVERNANCE_ADMIN_V2 } from "../../lib/resources/admin-bundle";
import { signupCodeHash } from "../../lib/onboarding/signup";
import { generateSignupCode, issueFromPlan, planMarker, planSignupCode, SignupPlanRefusal } from "../../scripts/operators/signup-codes";
import { POST as signupBegin } from "../../app/api/auth/signup/begin/route";
import { POST as signupComplete } from "../../app/api/auth/signup/complete/route";
import { POST as loginBegin } from "../../app/api/auth/local/begin/route";
import { POST as loginComplete } from "../../app/api/auth/local/complete/route";
import { softwarePasskey } from "../helpers/software-passkey";

// Customer Self-Onboarding v1, steps 3 and 4: beta code, atomic organization + first administrator,
// and the new organization's first sign-in, through the real routes as app_user on PostgreSQL.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const suffix = randomUUID().slice(0, 8);
let owner: PrismaClient;
let ipCounter = 0;
const call = async (handler: (request: Request) => Promise<Response>, path: string, body: unknown) => {
  const response = await handler(new Request(`http://localhost:3000${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": `203.0.113.${++ipCounter}-${suffix}` }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
};
async function issue() {
  const code = generateSignupCode();
  const row = await owner.signupCode.create({ data: { codeHash: signupCodeHash(code)!, issuedBy: "ci", expiresAt: new Date(Date.now() + 86_400_000) } });
  return { code, id: row.id };
}
const request = (code: string, slug: string, extra: Record<string, unknown> = {}) =>
  ({ code, organizationName: `Org ${slug}`, organization: slug, founderName: "Founder Person", principalName: "founder@example.test", ...extra });

describe.runIf(enabled)("Beta-code signup: atomic organization and first administrator (app_user, PostgreSQL)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
  });
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("creates exactly one organization with exactly one founder administrator, then the code is spent", async () => {
    const { code, id } = await issue();
    const slug = `newco-${suffix}`;
    expect((await call(signupBegin, "/api/auth/signup/begin", request("LUXIA-AAAAA-BBBBB-CCCCC-DDDDD", slug))).body).toEqual({ error: "SIGNUP_CODE_INVALID" });
    // Browser-supplied authority is ignored: only catalog entitlements are ever granted.
    const begin = await call(signupBegin, "/api/auth/signup/begin", request(code, slug, { role: "ADMIN", entitlements: ["users.delete"], tenantId: randomUUID() }));
    expect(begin.status).toBe(200);
    expect(Object.keys(begin.body).sort()).toEqual(["challenge", "rp", "user"]);
    expect(await owner.organization.count({ where: { slug } })).toBe(0); // begin creates nothing

    const passkey = softwarePasskey();
    const done = await call(signupComplete, "/api/auth/signup/complete", { code, ...passkey.register(begin.body.challenge), organization: "legrand-tech" });
    expect(done).toMatchObject({ status: 200, body: { status: "CREATED", organization: slug } });

    const org = await owner.organization.findUniqueOrThrow({ where: { slug }, include: { tenants: true } });
    expect(org.name).toBe(`Org ${slug}`);
    expect(org.tenants).toHaveLength(1);
    const scope = { organizationId: org.id, tenantId: org.tenants[0].id };
    const founders = await owner.subject.findMany({ where: scope });
    expect(founders).toHaveLength(1);
    expect(founders[0]).toMatchObject({ name: "Founder Person", type: "HUMAN", lifecycleState: "ACTIVE" });
    const grants = await owner.assignment.findMany({ where: { ...scope, status: "ACTIVE" }, include: { entitlement: true } });
    expect(grants.every(row => row.subjectId === founders[0].id && row.source === "DIRECT")).toBe(true);
    expect(grants.map(row => row.entitlement.key).sort()).toEqual([...LUXIA_ORG_ADMIN_V1.entitlements, ...GOVERNANCE_ADMIN_V2].sort());
    expect(new Set(grants.map(row => row.sourceRef))).toEqual(new Set(["native-role:LUXIA_ORG_ADMIN:v1", "native-role:LUXIA_ORG_ADMIN:v2"]));
    const authenticators = await owner.localAuthenticator.findMany({ where: scope });
    expect(authenticators).toHaveLength(1);
    expect(authenticators[0]).toMatchObject({ credentialId: passkey.credentialId, status: "ACTIVE", hardwareBound: false, userVerificationRequired: true, relyingPartyId: "localhost", allowedOrigin: "http://localhost:3000" });
    const events = await owner.canonicalAdminAuditEvent.findMany({ where: scope, orderBy: { occurredAt: "asc" } });
    expect(events.map(row => row.operation).sort()).toEqual(["LOCAL_AUTHENTICATOR.ENROLL", "ORGANIZATION.CREATE", "ROLE.GOVERNANCE.GRANT", "ROLE_BUNDLE.GRANT"]);
    expect(JSON.stringify(events)).not.toContain(code);
    expect(await owner.signupCode.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "CONSUMED", organizationId: org.id, pendingPayload: null });

    // Replay: the code is spent, at both steps.
    expect((await call(signupComplete, "/api/auth/signup/complete", { code, ...passkey.register(begin.body.challenge) })).body).toEqual({ error: "SIGNUP_CODE_INVALID" });
    expect((await call(signupBegin, "/api/auth/signup/begin", request(code, `again-${suffix}`))).body).toEqual({ error: "SIGNUP_CODE_INVALID" });

    // Another organization sees nothing of the new one.
    const legacy = await owner.organization.create({ data: { name: "Neighbour", slug: `neighbour-${suffix}` } });
    const legacyTenant = await owner.tenant.create({ data: { organizationId: legacy.id, name: "Production" } });
    const seen = await withTenantDb({ organizationId: legacy.id, tenantId: legacyTenant.id }, tx => tx.subject.count({ where: { organizationId: org.id } }));
    expect(seen).toBe(0);
  });

  it("the new organization signs in on its own, with its own identifier, and nowhere else", async () => {
    const { code } = await issue();
    const slug = `solo-${suffix}`;
    const passkey = softwarePasskey();
    const begin = await call(signupBegin, "/api/auth/signup/begin", request(code, slug, { principalName: "solo@example.test" }));
    expect((await call(signupComplete, "/api/auth/signup/complete", { code, ...passkey.register(begin.body.challenge) })).status).toBe(200);

    const elsewhere = await call(loginBegin, "/api/auth/local/begin", { organization: `newco-${suffix}`, principalName: "solo@example.test" });
    expect(elsewhere.body.allowCredentials).not.toContain(passkey.credentialId);

    const started = await call(loginBegin, "/api/auth/local/begin", { organization: slug, principalName: "solo@example.test" });
    expect(started.body.allowCredentials).toEqual([]); // finding F1: never listed
    const signedIn = await call(loginComplete, "/api/auth/local/complete", { organization: slug, transactionId: started.body.transactionId, challenge: started.body.challenge, ...passkey.assert(started.body.challenge) });
    expect(signedIn.status).toBe(200);
    expect(signedIn.cookie).toMatch(/luxia_session=/);
    const org = await owner.organization.findUniqueOrThrow({ where: { slug } });
    expect(await owner.session.count({ where: { organizationId: org.id, revokedAt: null } })).toBe(1);
    expect(await owner.authenticationEvidence.count({ where: { organizationId: org.id, outcome: "VERIFIED", method: "PASSKEY" } })).toBe(1);
  });

  it("requirement 5: a failure late in the founder transaction leaves no organization and the code still usable", async () => {
    const { code, id } = await issue();
    const slug = `broken-${suffix}`;
    // Test-only failure injection at the governance grant (the last authority step), scoped to this code.
    await owner.$executeRawUnsafe(`CREATE FUNCTION test_signup_failure_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."changeId" = 'signup:${id}:governance' THEN RAISE EXCEPTION 'INJECTED_FAILURE'; END IF; RETURN NEW; END $$`);
    await owner.$executeRawUnsafe(`CREATE TRIGGER test_signup_failure_${suffix} BEFORE INSERT ON "CanonicalAdminAuditEvent" FOR EACH ROW EXECUTE FUNCTION test_signup_failure_${suffix}()`);
    try {
      const passkey = softwarePasskey();
      const begin = await call(signupBegin, "/api/auth/signup/begin", request(code, slug));
      const failed = await call(signupComplete, "/api/auth/signup/complete", { code, ...passkey.register(begin.body.challenge) });
      expect(failed.status).toBe(503);
      expect(await owner.organization.count({ where: { slug } })).toBe(0);
      expect(await owner.tenant.count({ where: { organization: { slug } } })).toBe(0);
      expect(await owner.signupCode.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "RESERVED", organizationId: null, consumedAt: null });
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER test_signup_failure_${suffix} ON "CanonicalAdminAuditEvent"`);
      await owner.$executeRawUnsafe(`DROP FUNCTION test_signup_failure_${suffix}()`);
    }
    // Same code, fresh ceremony: succeeds once the cause is gone.
    const passkey = softwarePasskey();
    const begin = await call(signupBegin, "/api/auth/signup/begin", request(code, slug));
    expect((await call(signupComplete, "/api/auth/signup/complete", { code, ...passkey.register(begin.body.challenge) })).status).toBe(200);
    expect(await owner.organization.count({ where: { slug } })).toBe(1);
  });

  it("a taken identifier is refused before any creation, and only to a valid code holder", async () => {
    const { code } = await issue();
    expect((await call(signupBegin, "/api/auth/signup/begin", request("LUXIA-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ", `newco-${suffix}`))).body).toEqual({ error: "SIGNUP_CODE_INVALID" });
    expect((await call(signupBegin, "/api/auth/signup/begin", request(code, `newco-${suffix}`))).body).toEqual({ error: "ORGANIZATION_SLUG_UNAVAILABLE" });
    for (const bad of ["admin", "Bad Slug", "a"]) expect((await call(signupBegin, "/api/auth/signup/begin", request(code, bad))).body).toEqual({ error: "INVALID_REQUEST" });
  });

  it("a registration from another origin or without user verification is refused and creates nothing", async () => {
    const { code, id } = await issue();
    const slug = `strict-${suffix}`;
    const passkey = softwarePasskey();
    const begin = await call(signupBegin, "/api/auth/signup/begin", request(code, slug));
    for (const overrides of [{ origin: "https://evil.example" }, { flags: 0x41 }, { rpId: "evil.example" }]) {
      const refused = await call(signupComplete, "/api/auth/signup/complete", { code, ...passkey.register(begin.body.challenge, overrides) });
      expect(refused.body).toEqual({ error: "PASSKEY_REGISTRATION_INVALID" });
    }
    expect(await owner.organization.count({ where: { slug } })).toBe(0);
    expect((await owner.signupCode.findUniqueOrThrow({ where: { id } })).status).toBe("RESERVED");
  });

  it("the operator gate refuses a plan past its deadline at the write, by the database's clock", async () => {
    const { plan, digest } = planSignupCode({ by: "ci", days: "2", note: `late ${suffix}` },
      { host: "localhost", database: "ci", schema: "public", role: "ci" }, "c".repeat(40), new Date(Date.now() - 3_600_000));
    await expect(issueFromPlan(owner, plan, digest)).rejects.toThrow("PLAN_EXPIRED");
    expect(await owner.signupCode.count({ where: { note: { startsWith: planMarker(digest) } } })).toBe(0);
  });

  it("the operator gate issues one usable code per confirmed plan, and only its hash is stored", async () => {
    const { plan, digest } = planSignupCode({ by: "ci", days: "2", note: `gate ${suffix}` },
      { host: "localhost", database: "ci", schema: "public", role: "ci" }, "c".repeat(40));
    const { code, row } = await issueFromPlan(owner, plan, digest);
    expect(row).toMatchObject({ status: "ISSUED", issuedBy: "ci", note: `${planMarker(digest)} gate ${suffix}`, codeHash: signupCodeHash(code) });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(2 * 86_400_000);
    await expect(issueFromPlan(owner, plan, digest)).rejects.toThrow(SignupPlanRefusal);
    expect(await owner.signupCode.count({ where: { note: { startsWith: planMarker(digest) } } })).toBe(1);
    const begin = await call(signupBegin, "/api/auth/signup/begin", request(code, `gate-${suffix}`));
    expect(begin.status).toBe(200);
  });
});
