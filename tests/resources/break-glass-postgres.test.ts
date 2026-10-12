import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { SessionStore } from "../../lib/auth/session-store";
import { resolveLoginOrganization } from "../../lib/auth/organization-login";
import { countDurableAdministrators, durableAdministratorWhere } from "../../lib/admin/last-administrator";
import { beginAcceptance, completeAcceptance } from "../../lib/onboarding/invitations";
import { applyBreakGlass, planBreakGlass, type BreakGlassAction, type DnsCheck } from "../../lib/operators/break-glass";
import { softwarePasskey } from "../helpers/software-passkey";

// First Admin / Break-glass v1, B4: the operator procedure on PostgreSQL. The command runs as the owner
// (the operator role); the product views (sessions, invitation acceptance) run as app_user.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const suffix = randomUUID().slice(0, 8);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const TOOL = "test-tool-version";
const absent: DnsCheck = async () => "ABSENT";
let owner: PrismaClient;
let orgs = 0;

type Person = { subjectId: string; accountId: string; principalName: string };
type Org = { slug: string; organizationId: string; tenantId: string; local: string; founder: Person };
async function person(org: { organizationId: string; tenantId: string; local: string }, name: string, admin: boolean): Promise<Person> {
  const scope = { organizationId: org.organizationId, tenantId: org.tenantId };
  const subject = await owner.subject.create({ data: { ...scope, type: "HUMAN", name, lifecycleState: "ACTIVE" } });
  const account = await owner.identityAccount.create({ data: { ...scope, subjectId: subject.id, providerConnectionId: org.local, externalObjectId: randomUUID() } });
  const principalName = `${name.toLowerCase().replace(/\W/g, "")}-${randomUUID().slice(0, 6)}`;
  await owner.localIdentity.create({ data: { ...scope, identityAccountId: account.id, principalName } });
  const key = softwarePasskey();
  await owner.localAuthenticator.create({ data: { ...scope, identityAccountId: account.id, type: "PASSKEY", credentialId: key.credentialId, publicKey: key.publicKeyPem,
    relyingPartyId: "localhost", allowedOrigin: "http://localhost:3000", credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY", algorithmId: "WEBAUTHN_ES256" } });
  if (admin) {
    const entitlement = await owner.entitlement.upsert({ where: { organizationId_tenantId_key: { ...scope, key: "assignments.manage" } }, update: {},
      create: { ...scope, key: "assignments.manage", resource: "assignments", action: "manage" } });
    await owner.assignment.create({ data: { ...scope, subjectId: subject.id, entitlementId: entitlement.id, source: "DIRECT", sourceRef: "b4-test" } });
  }
  return { subjectId: subject.id, accountId: account.id, principalName };
}
async function organization(): Promise<Org> {
  const organizationId = randomUUID(), tenantId = randomUUID(), slug = `bg-${suffix}-${++orgs}`;
  await owner.organization.create({ data: { id: organizationId, name: "Break-glass test", slug } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const connection = await owner.providerConnection.create({ data: { organizationId, providerType: "LUXIA_LOCAL", externalScopeId: `local-${organizationId}`, name: "LUXIA Local" } });
  await owner.providerConnectionTenantScope.create({ data: { organizationId, tenantId, providerConnectionId: connection.id } });
  const base = { organizationId, tenantId, local: connection.id };
  return { slug, ...base, founder: await person(base, "Founder", true) };
}
const scope = (org: Org) => ({ organizationId: org.organizationId, tenantId: org.tenantId });
const signIn = (org: Org, p: Person = org.founder) => SessionStore.createSession({ ...scope(org), subjectId: p.subjectId, identityAccountId: p.accountId });
const certification = (org: Org) => ({ type: "LUXIA_CERTIFICATION", id: `CERT-${suffix}` });
const customer = (actions: BreakGlassAction[], namedPerson?: string) => ({ type: "VERIFIED_CUSTOMER_REQUEST", id: `REQ-${randomUUID().slice(0, 8)}`,
  requester: { name: "Jeanne Martin", role: "Directrice générale", channel: "Courrier signé" },
  verificationMethods: ["CALLBACK_KNOWN_CONTACT", "SIGNED_LETTER_OR_CONTRACT"], documentSha256: sha(randomUUID()), requestedActions: actions,
  ...(namedPerson ? { namedPerson } : {}) });
const request = (org: Org, action: BreakGlassAction, reference: Record<string, unknown>, target: Record<string, unknown> = {}) =>
  ({ action, organization: org.slug, reason: "Certification B4 sur PostgreSQL", reference, ...target });
const options = (org: Org, extra: Record<string, unknown> = {}) =>
  ({ issuedAt: new Date(Math.floor(Date.now() / 1000) * 1000), toolVersion: TOOL, dns: absent, certificationOrganizations: [org.slug], ...extra });
/** Dry run then apply, as the operator command does. */
async function run(org: Org, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const opts = options(org, extra);
  const { plan, digest } = await planBreakGlass(owner, input, opts);
  return { plan, digest, result: await applyBreakGlass(owner, input, { ...opts, confirm: digest, ...extra }) };
}
const codeOf = (promise: Promise<unknown>) => promise.then(() => "OK", (error: { code?: string; message?: string }) => error.code ?? error.message);
const events = (org: Org) => owner.canonicalAdminAuditEvent.findMany({ where: { organizationId: org.organizationId, operation: { startsWith: "BREAK_GLASS." } }, orderBy: { occurredAt: "asc" } });
const status = async (org: Org) => (await owner.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).status;

describe.runIf(enabled)("B4 operator break-glass procedure (owner command, app_user product, PostgreSQL)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
  });
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("a dry run writes nothing; apply recomputes the plan, acts, journals once by the operator, and verifies the committed state", async () => {
    const org = await organization();
    await signIn(org); await signIn(org);
    const input = request(org, "SUSPEND_ORGANIZATION", { type: "LUXIA_INCIDENT", id: "INC-1" });
    const before = { subjects: await owner.subject.count({ where: scope(org) }), events: await owner.canonicalAdminAuditEvent.count({ where: scope(org) }) };
    const { plan, digest } = await planBreakGlass(owner, input, options(org));
    expect(plan).toMatchObject({ organization: { slug: org.slug, status: "ACTIVE" }, counts: { openSessions: 2, durableAdministrators: 1 }, expected: { status: "SUSPENDED", openSessions: 0 } });
    expect({ subjects: await owner.subject.count({ where: scope(org) }), events: await owner.canonicalAdminAuditEvent.count({ where: scope(org) }) }).toEqual(before);

    const result = await applyBreakGlass(owner, input, { ...options(org), issuedAt: new Date(plan.issuedAt), confirm: digest });
    expect(result).toMatchObject({ changeId: `break-glass:${digest}`, effects: { from: "ACTIVE", to: "SUSPENDED", revokedSessions: 2 }, committed: { verified: true } });
    expect(await status(org)).toBe("SUSPENDED");
    const [event] = await events(org);
    expect(event).toMatchObject({ operation: "BREAK_GLASS.ORGANIZATION.SUSPEND", result: "SUCCESS", changeId: `break-glass:${digest}`,
      metadata: { planDigest: digest, reference: { type: "LUXIA_INCIDENT", id: "INC-1" }, before: { openSessions: 2 } } });
    // The operator: a disabled SERVICE subject, with no account, assignment or session.
    const operator = await owner.subject.findUniqueOrThrow({ where: { id: event.actorSubjectId }, include: { identities: true, Assignment: true } });
    expect(operator).toMatchObject({ type: "SERVICE", name: "Opérateur LUXIA (break-glass)", lifecycleState: "DISABLED", identities: [], Assignment: [] });
    // Replaying the same confirmation: the state changed, so the digest no longer matches.
    expect(await codeOf(applyBreakGlass(owner, input, { ...options(org), issuedAt: new Date(plan.issuedAt), confirm: digest }))).toBe("ORGANIZATION_STATUS_REFUSED");
    expect(await events(org)).toHaveLength(1);
  }, 60_000);

  it("one plan applies at most once (unique changeId), and any change between dry run and apply is refused with nothing written", async () => {
    const org = await organization();
    const revoke = request(org, "REVOKE_SESSIONS", { type: "LUXIA_INCIDENT", id: "INC-2" });
    await run(org, revoke); // creates the operator identity, which is part of the plan state
    const opts = options(org);
    const { digest } = await planBreakGlass(owner, revoke, opts);
    expect((await applyBreakGlass(owner, revoke, { ...opts, confirm: digest })).effects).toEqual({ revokedSessions: 0 });
    // Same plan, same state: the unique changeId refuses the replay (D6), nothing written.
    expect(await codeOf(applyBreakGlass(owner, revoke, { ...opts, confirm: digest }))).toBe("ALREADY_APPLIED");
    expect(await events(org)).toHaveLength(2);

    const later = options(org, { issuedAt: new Date(opts.issuedAt.getTime() + 1000) });
    const second = await planBreakGlass(owner, revoke, later);
    await signIn(org); // the state changes after the dry run
    expect(await codeOf(applyBreakGlass(owner, revoke, { ...later, confirm: second.digest }))).toBe("DIGEST_MISMATCH");
    // Another input, another tool version, or a later time: refused, nothing written.
    expect(await codeOf(applyBreakGlass(owner, { ...revoke, reason: "Une autre raison plus longue" }, { ...later, confirm: second.digest }))).toBe("DIGEST_MISMATCH");
    expect(await codeOf(applyBreakGlass(owner, revoke, { ...later, toolVersion: "other", confirm: second.digest }))).toBe("DIGEST_MISMATCH");
    expect(await codeOf(applyBreakGlass(owner, revoke, { ...later, confirm: second.digest, now: new Date(later.issuedAt.getTime() + 16 * 60_000) }))).toBe("PLAN_EXPIRED");
    expect(await events(org)).toHaveLength(2);
    expect(await owner.session.count({ where: { organizationId: org.organizationId, revokedAt: null } })).toBe(1);
    // Authority is checked again at apply: an incident cannot close, a request cannot exceed its own list.
    expect(await codeOf(applyBreakGlass(owner, request(org, "CLOSE_ORGANIZATION", { type: "LUXIA_INCIDENT", id: "INC-3" }), { ...later, confirm: second.digest, irreversible: org.slug }))).toBe("AUTHORITY_REFUSED");
    expect(await codeOf(planBreakGlass(owner, request(org, "CLOSE_ORGANIZATION", customer(["SUSPEND_ORGANIZATION"])), later))).toBe("ACTION_NOT_REQUESTED");
  }, 60_000);

  it("D2: the last durable administrator is protected while ACTIVE; once SUSPENDED it can be disabled, with the typed identifier", async () => {
    const org = await organization();
    await signIn(org);
    const disable = request(org, "DISABLE_ACCOUNT", customer(["SUSPEND_ORGANIZATION", "DISABLE_ACCOUNT"]), { identityAccountId: org.founder.accountId });
    expect(await codeOf(planBreakGlass(owner, disable, options(org)))).toBe("LAST_ADMINISTRATOR_PROTECTED");
    // A second administrator: the first one is no longer the last, so it can be disabled while ACTIVE.
    const other = await organization();
    const second = await person({ ...scope(other), local: other.local }, "Second", true);
    const disableFounder = request(other, "DISABLE_ACCOUNT", customer(["DISABLE_ACCOUNT"]), { identityAccountId: other.founder.accountId });
    const planned = await planBreakGlass(owner, disableFounder, options(other));
    expect(await codeOf(applyBreakGlass(owner, disableFounder, { ...options(other), issuedAt: new Date(planned.plan.issuedAt), confirm: planned.digest }))).toBe("IRREVERSIBLE_CONFIRMATION_REQUIRED");
    expect((await applyBreakGlass(owner, disableFounder, { ...options(other), issuedAt: new Date(planned.plan.issuedAt), confirm: planned.digest, irreversible: other.slug })).committed.verified).toBe(true);
    expect(await countDurableAdministrators(owner, scope(other))).toBe(1);
    void second;

    // One verified customer request names the whole sequence (D2 with Q1).
    await run(org, request(org, "SUSPEND_ORGANIZATION", disable.reference as Record<string, unknown>));
    const { result } = await run(org, disable, { irreversible: org.slug });
    expect(result.effects).toEqual({ identityAccountId: org.founder.accountId, localIdentityDisabled: true, passkeysRevoked: 1, sessionsRevoked: 0 });
    expect(result.committed).toMatchObject({ verified: true, observed: { account: { status: "DISABLED", localIdentityStatus: "DISABLED", activePasskeys: 0, openSessions: 0 } } });
    expect(await countDurableAdministrators(owner, scope(org))).toBe(0);
    const [, disabled] = await events(org);
    expect(disabled).toMatchObject({ operation: "BREAK_GLASS.IDENTITY_ACCOUNT.DISABLE", targetSubjectId: org.founder.subjectId,
      metadata: { reference: { type: "VERIFIED_CUSTOMER_REQUEST", requestedActions: ["DISABLE_ACCOUNT", "SUSPEND_ORGANIZATION"] } } });
  }, 60_000);

  it("RELEASE_DOMAIN only when the TXT record is absent on both resolvers", async () => {
    const org = await organization();
    const domain = `b4-${randomUUID().slice(0, 8)}.example.com`;
    await owner.organizationDomain.create({ data: { ...scope(org), domain, status: "VERIFIED", verifiedAt: new Date(), challengeHash: sha(randomUUID()),
      challengeExpiresAt: new Date(Date.now() + 86_400_000) } });
    const release = request(org, "RELEASE_DOMAIN", certification(org), { domain });
    const present: DnsCheck = async (server) => server === "8.8.8.8" ? "PRESENT" : "ABSENT";
    expect(await codeOf(planBreakGlass(owner, release, options(org, { dns: present })))).toBe("DNS_RECORD_PRESENT");
    expect(await codeOf(planBreakGlass(owner, release, options(org, { dns: async () => "UNKNOWN" })))).toBe("DNS_CHECK_FAILED");
    const { plan, result } = await run(org, release);
    expect(plan.target).toMatchObject({ domain, record: `_luxia-verification.${domain}`, dns: { "1.1.1.1": "ABSENT", "8.8.8.8": "ABSENT" } });
    expect(result).toMatchObject({ effects: { domain, from: "VERIFIED", to: "LOST" }, committed: { verified: true } });
  }, 60_000);

  it("CLOSE_ORGANIZATION: only the B3 effects, the exact identifier typed, then final and unknown at sign-in (D4)", async () => {
    const org = await organization();
    await signIn(org);
    const close = request(org, "CLOSE_ORGANIZATION", customer(["CLOSE_ORGANIZATION"]));
    const opts = options(org);
    const { digest } = await planBreakGlass(owner, close, opts);
    expect(await codeOf(applyBreakGlass(owner, close, { ...opts, confirm: digest }))).toBe("IRREVERSIBLE_CONFIRMATION_REQUIRED");
    expect(await codeOf(applyBreakGlass(owner, close, { ...opts, confirm: digest, irreversible: "legrand-tech" }))).toBe("IRREVERSIBLE_CONFIRMATION_REQUIRED");
    const result = await applyBreakGlass(owner, close, { ...opts, confirm: digest, irreversible: org.slug });
    expect(result).toMatchObject({ effects: { from: "ACTIVE", to: "CLOSED", revokedSessions: 1 }, committed: { verified: true } });
    // D4: accounts and passkeys are left as they are; sign-in is refused at the organization level.
    expect(await owner.identityAccount.findUniqueOrThrow({ where: { id: org.founder.accountId } })).toMatchObject({ status: "ACTIVE" });
    expect(await owner.localAuthenticator.count({ where: { organizationId: org.organizationId, status: "ACTIVE" } })).toBe(1);
    expect(await resolveLoginOrganization(org.slug)).toBeNull();
    expect(await codeOf(planBreakGlass(owner, request(org, "REACTIVATE_ORGANIZATION", customer(["REACTIVATE_ORGANIZATION"])), options(org)))).toBe("ORGANIZATION_CLOSED");
  }, 60_000);

  it("RECOVERY_INVITATION (D3): only when no administrator can sign in, 24 h, opaque token never stored, authority from the event alone", async () => {
    const org = await organization();
    const named = "Nouvelle Administratrice";
    const invite = request(org, "RECOVERY_INVITATION", customer(["RECOVERY_INVITATION"], named), { namedPerson: named });
    expect(await codeOf(planBreakGlass(owner, invite, options(org)))).toBe("ADMINISTRATOR_CAN_SIGN_IN");
    // The only administrator lost the passkey: nobody can sign in any more.
    await owner.localAuthenticator.updateMany({ where: { identityAccountId: org.founder.accountId }, data: { status: "REVOKED", revokedAt: new Date() } });
    const { plan, result } = await run(org, invite);
    expect(plan.counts.administratorsAbleToSignIn).toBe(0);
    const token = result.invitationToken!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const invitation = await owner.invitation.findUniqueOrThrow({ where: { id: String(result.effects.invitationId) } });
    expect(invitation).toMatchObject({ role: "ADMIN", issuedByOperatorChangeId: result.changeId, tokenHash: sha(token), acceptedAt: null });
    expect(invitation.expiresAt.getTime() - invitation.createdAt.getTime()).toBe(24 * 3_600_000); // set by the database
    const [event] = await events(org);
    expect(event).toMatchObject({ operation: "BREAK_GLASS.RECOVERY_INVITATION.ISSUE", metadata: { invitationId: invitation.id, targets: { namedPerson: named } } });
    const { invitationToken: _shownOnce, ...recorded } = result;
    expect(JSON.stringify(await owner.canonicalAdminAuditEvent.findMany({ where: scope(org) })) + JSON.stringify(recorded) + JSON.stringify(plan)).not.toContain(token);

    // Acceptance by the named person (app_user, no session): administrator by the event's authority.
    const passkey = softwarePasskey();
    const begun = await beginAcceptance({ token, principalName: `nouvelle-${suffix}` }, "localhost");
    await completeAcceptance({ token, principalName: `nouvelle-${suffix}`, ...passkey.register(begun.challenge) }, { rpId: "localhost", origin: "http://localhost:3000" });
    // The named person is now a durable administrator (the founder still counts: the account is ACTIVE).
    expect(await owner.subject.count({ where: { ...durableAdministratorWhere(scope(org), new Date()), id: invitation.subjectId } })).toBe(1);
    const grants = await owner.canonicalAdminAuditEvent.findMany({ where: { ...scope(org), operation: { in: ["ROLE_BUNDLE.GRANT", "ROLE.GOVERNANCE.GRANT"] } } });
    expect(grants.map((g) => (g.metadata as { operatorChangeId?: string }).operatorChangeId)).toEqual([result.changeId, result.changeId]);
    expect(await owner.assignment.count({ where: { ...scope(org), subjectId: event.actorSubjectId } })).toBe(0); // the operator holds nothing

    // The application can never create an operator invitation, and without its event a link is worthless.
    const subject = await owner.subject.create({ data: { ...scope(org), type: "HUMAN", name: "Forged", lifecycleState: "PROVISIONING" } });
    const forge = (changeId: string) => ({ ...scope(org), subjectId: subject.id, tokenHash: sha(randomUUID()), role: "ADMIN" as const,
      invitedBySubjectId: event.actorSubjectId, issuedByOperatorChangeId: changeId });
    await expect(withTenantDb(scope(org), (tx) => tx.invitation.create({ data: forge(`break-glass:${"a".repeat(64)}`) }))).rejects.toThrow(/INVITATION_OPERATOR_ONLY/);
    const forged = await owner.invitation.create({ data: forge(`break-glass:${"b".repeat(64)}`) });
    await expect(owner.invitation.update({ where: { id: forged.id }, data: { acceptedAt: new Date() } })).rejects.toThrow(/INVITATION_OPERATOR_AUTHORITY_MISSING/);
    await expect(owner.invitation.create({ data: { ...forge(`break-glass:${"c".repeat(64)}`), role: "MEMBER" } })).rejects.toThrow(/Invitation_operator_change_format/);
  }, 60_000);

  it("race: two applies of the same plan: exactly one acts and journals", async () => {
    const org = await organization();
    const input = request(org, "SUSPEND_ORGANIZATION", certification(org));
    const opts = options(org);
    const { digest } = await planBreakGlass(owner, input, opts);
    const results = await Promise.all([1, 2].map(() => codeOf(applyBreakGlass(owner, input, { ...opts, confirm: digest }))));
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect(results.find((r) => r !== "OK")).toMatch(/ORGANIZATION_STATUS_REFUSED|DIGEST_MISMATCH|ALREADY_APPLIED/);
    expect(await events(org)).toHaveLength(1);
  }, 60_000);

  it("the Lab sequence through the procedure only: same before/after as the 2026-10-11 SQL action, then CLOSED", async () => {
    const org = await organization();
    const member = await person({ ...scope(org), local: org.local }, "Member", false);
    await signIn(org); await signIn(org, member);
    const domain = `lab-${randomUUID().slice(0, 8)}.example.com`;
    await owner.organizationDomain.create({ data: { ...scope(org), domain, status: "VERIFIED", verifiedAt: new Date(), challengeHash: sha(randomUUID()),
      challengeExpiresAt: new Date(Date.now() + 86_400_000) } });
    const ref = certification(org);
    await run(org, request(org, "SUSPEND_ORGANIZATION", ref));
    await run(org, request(org, "REVOKE_SESSIONS", ref));
    await run(org, request(org, "DISABLE_ACCOUNT", ref, { identityAccountId: org.founder.accountId }), { irreversible: org.slug });
    await run(org, request(org, "DISABLE_ACCOUNT", ref, { identityAccountId: member.accountId }), { irreversible: org.slug });
    await run(org, request(org, "RELEASE_DOMAIN", ref, { domain }));
    const { result } = await run(org, request(org, "CLOSE_ORGANIZATION", ref), { irreversible: org.slug });
    expect(result.committed).toMatchObject({ verified: true, observed: { status: "CLOSED", openSessions: 0, activeAccounts: 0, activeLocalIdentities: 0,
      activePasskeys: 0, heldDomains: 0, durableAdministrators: 0 } });
    expect(await owner.organizationDomain.findFirstOrThrow({ where: { organizationId: org.organizationId, domain } })).toMatchObject({ status: "LOST" });
    const journal = await events(org);
    expect(journal.map((e) => e.operation)).toEqual(["BREAK_GLASS.ORGANIZATION.SUSPEND", "BREAK_GLASS.SESSION.REVOKE", "BREAK_GLASS.IDENTITY_ACCOUNT.DISABLE",
      "BREAK_GLASS.IDENTITY_ACCOUNT.DISABLE", "BREAK_GLASS.DOMAIN.RELEASE", "BREAK_GLASS.ORGANIZATION.CLOSE"]);
    expect(new Set(journal.map((e) => e.actorSubjectId)).size).toBe(1);
    expect(await owner.subject.count({ where: { ...scope(org), type: "SERVICE" } })).toBe(1);
    expect(await resolveLoginOrganization(org.slug)).toBeNull();
  }, 120_000);
});
