// The onboarding checklist answers each item only under its own read right, on PostgreSQL with app_user and forced RLS.
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { getOnboardingChecklist } from "../../lib/onboarding/checklist";
import { softwarePasskey } from "../helpers/software-passkey";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const change = () => `read:checklist:${randomUUID()}`;
let owner: PrismaClient;
type Org = { organizationId: string; tenantId: string };
const rich: Org = { organizationId: randomUUID(), tenantId: randomUUID() };
const bare: Org = { organizationId: randomUUID(), tenantId: randomUUID() };
const ALL_NULL = { domainVerified: null, secondAdministrator: null, recoveryCodes: null, teamInvited: null, firstResource: null, firstAccessReview: null };

async function organization(org: Org) {
  await owner.organization.create({ data: { id: org.organizationId, name: "Checklist rights", slug: `checklist-${randomUUID().slice(0, 8)}` } });
  await owner.tenant.create({ data: { id: org.tenantId, organizationId: org.organizationId, name: "Production" } });
}
async function grant(org: Org, subjectId: string, key: string, extra: { validUntil?: Date; validFrom?: Date; status?: "REVOKED"; source?: "LEGACY_ROLE" } = {}) {
  const [resource, action] = key.split(".");
  const entitlement = await owner.entitlement.findUnique({ where: { organizationId_tenantId_key: { ...org, key } } })
    ?? await owner.entitlement.create({ data: { ...org, key, resource, action } });
  await owner.assignment.create({ data: { ...org, subjectId, entitlementId: entitlement.id, source: "DIRECT", sourceRef: randomUUID(), ...extra } });
}
/** A person holding exactly these global rights. */
async function viewer(org: Org, keys: string[]) {
  const subject = await owner.subject.create({ data: { ...org, type: "HUMAN", name: "Viewer", lifecycleState: "ACTIVE" } });
  for (const key of keys) await grant(org, subject.id, key);
  return { ...org, subjectId: subject.id };
}
const read = async (keys: string[], org = rich) => getOnboardingChecklist(await viewer(org, keys), change());

describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("Onboarding checklist: per-item read rights (app_user PostgreSQL/RLS)", () => {
  beforeAll(async () => {
    for (const url of [process.env.DATABASE_MIGRATION_URL, process.env.DATABASE_URL]) if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    await organization(rich);
    await organization(bare);
    // The rich organization holds a fact behind every item: all true, except recovery codes (none created).
    const connection = await owner.providerConnection.create({ data: { organizationId: rich.organizationId, providerType: "LUXIA_LOCAL", externalScopeId: `l-${rich.organizationId}`, name: "Local" } });
    await owner.providerConnectionTenantScope.create({ data: { ...rich, providerConnectionId: connection.id } });
    let administrator = "";
    for (let i = 0; i < 2; i++) {
      const admin = await owner.subject.create({ data: { ...rich, type: "HUMAN", name: `Admin ${i}`, lifecycleState: "ACTIVE" } });
      await grant(rich, admin.id, "assignments.manage");
      const account = await owner.identityAccount.create({ data: { ...rich, subjectId: admin.id, providerConnectionId: connection.id, externalObjectId: randomUUID() } });
      await owner.localIdentity.create({ data: { ...rich, identityAccountId: account.id, principalName: `admin-${randomUUID().slice(0, 8)}` } });
      const key = softwarePasskey();
      await owner.localAuthenticator.create({ data: { ...rich, identityAccountId: account.id, type: "PASSKEY", credentialId: key.credentialId, publicKey: key.publicKeyPem,
        relyingPartyId: "localhost", allowedOrigin: "http://localhost:3000", credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY", algorithmId: "WEBAUTHN_ES256" } });
      administrator = admin.id;
    }
    await owner.resource.create({ data: { ...rich, type: "API", name: "Checklist resource" } });
    // Real references: the backup round trip restores this database, foreign keys included.
    const reviewedScope = await owner.resourceScope.create({ data: { ...rich, key: "checklist", kind: "TENANT" } });
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.organizationDomain.create({ data: { ...rich, domain: `${randomUUID()}.example.test`, status: "VERIFIED", verifiedAt: new Date(), challengeHash: sha(randomUUID()), challengeExpiresAt: new Date(Date.now() + 1e8) } });
      await tx.accessReviewCampaign.create({ data: { ...rich, name: "Fixture", scopeId: reviewedScope.id, scopeType: "TENANT", reviewerSubjectId: administrator, createdBySubjectId: administrator, startsAt: new Date(), dueAt: new Date(Date.now() + 1e8) } });
    }, { timeout: 30_000 });
  }, 120_000);
  afterAll(async () => { await owner?.$disconnect(); await rawPrisma.$disconnect(); });

  it("subjects.read alone reveals neither domains, resources, access reviews nor the administrators' recovery state", async () => {
    expect(await read(["subjects.read"])).toEqual({ ...ALL_NULL, teamInvited: true });
  });

  it.each([
    ["providers.read", { domainVerified: true }],
    ["resources.read", { firstResource: true }],
    ["access_reviews.read_all", { firstAccessReview: true }],
  ])("%s unlocks only its own item", async (key, unlocked) => {
    expect(await read(["subjects.read", key])).toEqual({ ...ALL_NULL, teamInvited: true, ...unlocked });
  });

  it("the second administrator needs both rights that establish it", async () => {
    expect(await read(["subjects.read", "assignments.read"])).toEqual({ ...ALL_NULL, teamInvited: true });
    expect(await read(["subjects.read", "identity_accounts.read"])).toEqual({ ...ALL_NULL, teamInvited: true });
    expect(await read(["subjects.read", "assignments.read", "identity_accounts.read"])).toEqual({ ...ALL_NULL, teamInvited: true, secondAdministrator: true });
  });

  it("the administrators' recovery state needs the rights to appoint them and to read accounts", async () => {
    expect(await read(["subjects.read", "identity_accounts.read"])).toMatchObject({ recoveryCodes: null });
    expect(await read(["subjects.read", "assignments.manage"])).toMatchObject({ recoveryCodes: null });
    expect(await read(["subjects.read", "assignments.manage", "identity_accounts.read"])).toEqual({ ...ALL_NULL, teamInvited: true, recoveryCodes: false });
  });

  it("access_reviews.read gets null even when a campaign exists, never a false 'not done'; a global view gets the fact", async () => {
    expect(await read(["subjects.read", "access_reviews.read"])).toMatchObject({ firstAccessReview: null });
    expect(await read(["subjects.read", "access_reviews.manage"])).toMatchObject({ firstAccessReview: null });
    expect(await read(["subjects.read", "access_reviews.read", "access_reviews.manage"])).toMatchObject({ firstAccessReview: true });
  });

  it("no difference to infer: hidden items are the same whether the data exists or not", async () => {
    const withData = await read(["subjects.read"], rich);
    const without = await read(["subjects.read"], bare);
    expect({ ...withData, teamInvited: null }).toEqual(ALL_NULL);
    expect({ ...without, teamInvited: null }).toEqual(ALL_NULL);
    // With the right, the organization without data answers false: that fact is the viewer's to know.
    expect(await read(["subjects.read", "resources.read"], bare)).toMatchObject({ firstResource: false });
  });

  it("a right that is revoked, expired or resource-scoped unlocks nothing", async () => {
    const revoked = await viewer(rich, ["subjects.read"]);
    await grant(rich, revoked.subjectId, "providers.read", { status: "REVOKED" });
    expect(await getOnboardingChecklist(revoked, change())).toMatchObject({ domainVerified: null });
    const expired = await viewer(rich, ["subjects.read"]);
    await grant(rich, expired.subjectId, "resources.read", { validUntil: new Date(Date.now() - 1000) });
    expect(await getOnboardingChecklist(expired, change())).toMatchObject({ firstResource: null });
    const scoped = await viewer(bare, ["subjects.read"]);
    const narrow = await owner.resourceScope.create({ data: { ...bare, key: "narrow", kind: "TENANT" } });
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      const entitlement = await tx.entitlement.create({ data: { ...bare, key: "providers.read", resource: "providers", action: "read", resourceScopeId: narrow.id } });
      await tx.assignment.create({ data: { ...bare, subjectId: scoped.subjectId, entitlementId: entitlement.id, source: "DIRECT", sourceRef: randomUUID() } });
    }, { timeout: 30_000 });
    expect(await getOnboardingChecklist(scoped, change())).toMatchObject({ domainVerified: null });
  });

  it("a grant from a legacy role, or not yet valid, or on a disabled entitlement unlocks nothing", async () => {
    const legacy = await viewer(rich, ["subjects.read"]);
    await grant(rich, legacy.subjectId, "providers.read", { source: "LEGACY_ROLE" });
    expect(await getOnboardingChecklist(legacy, change())).toMatchObject({ domainVerified: null });
    const future = await viewer(rich, ["subjects.read"]);
    await grant(rich, future.subjectId, "resources.read", { validFrom: new Date(Date.now() + 3_600_000) });
    expect(await getOnboardingChecklist(future, change())).toMatchObject({ firstResource: null });
    const disabled = await viewer(rich, ["subjects.read"]);
    await grant(rich, disabled.subjectId, "access_reviews.read_all");
    await owner.entitlement.update({ where: { organizationId_tenantId_key: { ...rich, key: "access_reviews.read_all" } }, data: { active: false } });
    try {
      expect(await getOnboardingChecklist(disabled, change())).toMatchObject({ firstAccessReview: null });
    } finally {
      await owner.entitlement.update({ where: { organizationId_tenantId_key: { ...rich, key: "access_reviews.read_all" } }, data: { active: true } });
    }
  });

  it("without the checklist's own right the whole answer is refused", async () => {
    await expect(read(["resources.read"])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
