import { createHash, randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import type { Prisma, PrismaClient } from "@prisma/client";
import { durableAdministratorWhere, lockTenantGovernance, preserveLastAdministratorUnlessSuspended } from "../admin/last-administrator";
import { lockOrganizationActive, transitionOrganization, type OrganizationStatus } from "../organizations/lifecycle";
import { normalizeDomain, RECORD_PREFIX } from "../onboarding/domains";

// First Admin / Break-glass v1, B4: the operator break-glass procedure.
// Design (D1 to D7 and Q1 approved 2026-10-12): docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-B4-OPERATOR-DESIGN.md
//
// A closed list of named actions on one organization. No SQL, query or free expression is accepted:
// every input is validated against the closed list, the authority matrix and the target organization.
// A dry run computes the plan and its digest; apply recomputes the plan inside one owner transaction,
// under the governance locks and the organization row lock, and writes nothing unless the digest is the
// confirmed one. LUXIA never receives a grant, a session or an account in the tenant: actions are
// authored by a disabled SERVICE subject, "Opérateur LUXIA (break-glass)", in the organization journal.
// Reachable only from scripts/operators/break-glass.ts and the tests (architecture test).

export const BREAK_GLASS_ACTIONS = [
  "SUSPEND_ORGANIZATION", "REACTIVATE_ORGANIZATION", "CLOSE_ORGANIZATION", "REVOKE_SESSIONS",
  "DISABLE_ACCOUNT", "RELEASE_DOMAIN", "RECOVERY_INVITATION",
] as const;
export type BreakGlassAction = typeof BREAK_GLASS_ACTIONS[number];
export const REFERENCE_TYPES = ["LUXIA_INCIDENT", "LUXIA_CERTIFICATION", "VERIFIED_CUSTOMER_REQUEST"] as const;
export type ReferenceType = typeof REFERENCE_TYPES[number];

/**
 * D7 completed by Q1: the complete authority matrix. No reference gives generic or implicit authority.
 * LUXIA_CERTIFICATION acts only on LUXIA_CERTIFICATION_ORGANIZATIONS. VERIFIED_CUSTOMER_REQUEST allows
 * only the actions the request explicitly contains (its requestedActions, which are part of the digest).
 */
export const AUTHORITY: Readonly<Record<ReferenceType, readonly BreakGlassAction[]>> = {
  LUXIA_INCIDENT: ["SUSPEND_ORGANIZATION", "REVOKE_SESSIONS"],
  LUXIA_CERTIFICATION: BREAK_GLASS_ACTIONS,
  VERIFIED_CUSTOMER_REQUEST: BREAK_GLASS_ACTIONS,
};
/** Organizations explicitly marked as LUXIA certification organizations. Changed only by a reviewed PR. */
export const LUXIA_CERTIFICATION_ORGANIZATIONS: readonly string[] = ["luxia-certification-lab", "luxia-cert-b2-r6"];
/** Organizations on which only their own verified request can authorize an action. */
export const CUSTOMER_REQUEST_ONLY_ORGANIZATIONS: readonly string[] = ["legrand-tech"];
/** D1: independent out-of-band verification methods; a customer request needs at least two. */
export const VERIFICATION_METHODS = [
  "CALLBACK_KNOWN_CONTACT", "EMAIL_FROM_VERIFIED_DOMAIN", "OTHER_ADMINISTRATOR_CONFIRMATION", "SIGNED_LETTER_OR_CONTRACT",
] as const;
/** D4 and section 4: irreversible actions also need the exact organization identifier typed. */
export const IRREVERSIBLE_ACTIONS: readonly BreakGlassAction[] = ["CLOSE_ORGANIZATION", "DISABLE_ACCOUNT"];
export const PLAN_VALIDITY_MS = 15 * 60_000; // D5
export const OPERATOR_SUBJECT_NAME = "Opérateur LUXIA (break-glass)";
export const DNS_RESOLVERS = ["1.1.1.1", "8.8.8.8"] as const;
export const JOURNAL_OPERATION: Readonly<Record<BreakGlassAction, string>> = {
  SUSPEND_ORGANIZATION: "BREAK_GLASS.ORGANIZATION.SUSPEND",
  REACTIVATE_ORGANIZATION: "BREAK_GLASS.ORGANIZATION.REACTIVATE",
  CLOSE_ORGANIZATION: "BREAK_GLASS.ORGANIZATION.CLOSE",
  REVOKE_SESSIONS: "BREAK_GLASS.SESSION.REVOKE",
  DISABLE_ACCOUNT: "BREAK_GLASS.IDENTITY_ACCOUNT.DISABLE",
  RELEASE_DOMAIN: "BREAK_GLASS.DOMAIN.RELEASE",
  RECOVERY_INVITATION: "BREAK_GLASS.RECOVERY_INVITATION.ISSUE",
};

export type Reference = {
  type: ReferenceType;
  id: string;
  requester?: { name: string; role: string; channel: string };
  verificationMethods?: string[];
  documentSha256?: string;
  requestedActions?: BreakGlassAction[];
  namedPerson?: string;
};
export type BreakGlassInput = {
  action: BreakGlassAction;
  organization: string;
  identityAccountId?: string;
  domain?: string;
  namedPerson?: string;
  reference: Reference;
  reason: string;
};
export type DnsCheck = (resolver: string, name: string) => Promise<"PRESENT" | "ABSENT" | "UNKNOWN">;
export type BreakGlassOptions = {
  issuedAt: Date;
  toolVersion: string;
  /** Host and port of the connection. The operator command always sets it; part of the plan, so of the digest. */
  endpoint?: string;
  dns?: DnsCheck;
  /** Tests only; the operator command always uses LUXIA_CERTIFICATION_ORGANIZATIONS. */
  certificationOrganizations?: readonly string[];
};

export class BreakGlassRefusal extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "BreakGlassRefusal";
  }
}
function refuse(code: string, detail?: string): never { throw new BreakGlassRefusal(code, detail); }

type Tx = Prisma.TransactionClient;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Canonical JSON: keys sorted at every level, no whitespace. The plan digest is its SHA-256. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): Json => {
    if (v === undefined) return null;
    if (v === null || typeof v !== "object") return v as Json;
    if (Array.isArray(v)) return v.map(sort);
    return Object.fromEntries(Object.keys(v as object).sort()
      .filter((key) => (v as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, sort((v as Record<string, unknown>)[key])]));
  };
  return JSON.stringify(sort(value));
}
export const planDigest = (plan: unknown) => createHash("sha256").update(canonicalJson(plan), "utf8").digest("hex");

// ------------------------------------------------------------------------------------------------
// Input validation: closed list, authority matrix, justification. No database needed.
// ------------------------------------------------------------------------------------------------

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (value: unknown, min: number, max: number) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
};
const isAction = (value: unknown): value is BreakGlassAction => typeof value === "string" && (BREAK_GLASS_ACTIONS as readonly string[]).includes(value);

export function validateInput(raw: unknown, certificationOrganizations: readonly string[] = LUXIA_CERTIFICATION_ORGANIZATIONS): BreakGlassInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("INVALID_INPUT");
  const input = raw as Record<string, unknown>;
  const allowedKeys = ["action", "organization", "identityAccountId", "domain", "namedPerson", "reference", "reason"];
  const unknownKey = Object.keys(input).find((key) => !allowedKeys.includes(key));
  if (unknownKey) refuse("UNKNOWN_FIELD", unknownKey);
  if (!isAction(input.action)) refuse("UNKNOWN_ACTION");
  const action = input.action;
  const organization = typeof input.organization === "string" && SLUG.test(input.organization) ? input.organization : refuse("INVALID_ORGANIZATION");
  const reason = text(input.reason, 10, 1000) ?? refuse("REASON_REQUIRED");

  const ref = input.reference;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) refuse("REFERENCE_REQUIRED");
  const r = ref as Record<string, unknown>;
  const refKeys = ["type", "id", "requester", "verificationMethods", "documentSha256", "requestedActions", "namedPerson"];
  const unknownRefKey = Object.keys(r).find((key) => !refKeys.includes(key));
  if (unknownRefKey) refuse("UNKNOWN_FIELD", `reference.${unknownRefKey}`);
  if (typeof r.type !== "string" || !(REFERENCE_TYPES as readonly string[]).includes(r.type)) refuse("UNKNOWN_REFERENCE_TYPE");
  const type = r.type as ReferenceType;
  const id = text(r.id, 1, 200) ?? refuse("REFERENCE_ID_REQUIRED");
  // Authority matrix: no reference gives generic or implicit authority.
  if (!AUTHORITY[type].includes(action)) refuse("AUTHORITY_REFUSED", `${type} cannot authorize ${action}`);
  if (CUSTOMER_REQUEST_ONLY_ORGANIZATIONS.includes(organization) && type !== "VERIFIED_CUSTOMER_REQUEST")
    refuse("AUTHORITY_REFUSED", `${organization} accepts only its own verified request`);
  if (type === "LUXIA_CERTIFICATION" && !certificationOrganizations.includes(organization))
    refuse("AUTHORITY_REFUSED", `${organization} is not a LUXIA certification organization`);

  const reference: Reference = { type, id };
  if (type === "VERIFIED_CUSTOMER_REQUEST") {
    const requester = r.requester as Record<string, unknown> | undefined;
    const name = text(requester?.name, 2, 200), role = text(requester?.role, 2, 200), channel = text(requester?.channel, 2, 200);
    if (!name || !role || !channel) refuse("REQUESTER_REQUIRED");
    const methods = Array.isArray(r.verificationMethods) ? r.verificationMethods : [];
    if (methods.some((m) => typeof m !== "string" || !(VERIFICATION_METHODS as readonly string[]).includes(m))) refuse("UNKNOWN_VERIFICATION_METHOD");
    const distinctMethods = [...new Set(methods as string[])].sort();
    if (distinctMethods.length < 2) refuse("TWO_VERIFICATION_METHODS_REQUIRED");
    const documentSha256 = typeof r.documentSha256 === "string" && /^[0-9a-f]{64}$/.test(r.documentSha256) ? r.documentSha256 : refuse("DOCUMENT_SHA256_REQUIRED");
    const requested = Array.isArray(r.requestedActions) ? r.requestedActions : [];
    if (!requested.length || requested.some((a) => !isAction(a))) refuse("REQUESTED_ACTIONS_REQUIRED");
    const requestedActions = [...new Set(requested as BreakGlassAction[])].sort();
    // Q1: only the actions the request explicitly contains.
    if (!requestedActions.includes(action)) refuse("ACTION_NOT_REQUESTED", action);
    const namedPerson = r.namedPerson === undefined ? undefined : text(r.namedPerson, 2, 120) ?? refuse("INVALID_NAMED_PERSON");
    Object.assign(reference, { requester: { name, role, channel }, verificationMethods: distinctMethods, documentSha256, requestedActions, namedPerson });
  } else if (["requester", "verificationMethods", "documentSha256", "requestedActions", "namedPerson"].some((key) => r[key] !== undefined)) {
    refuse("UNEXPECTED_FIELD", "customer request fields need a VERIFIED_CUSTOMER_REQUEST");
  }

  // Each action takes exactly its own target: no free parameter.
  const result: BreakGlassInput = { action, organization, reference, reason };
  const has = (key: string) => input[key] !== undefined;
  if (action === "DISABLE_ACCOUNT") {
    result.identityAccountId = typeof input.identityAccountId === "string" && UUID.test(input.identityAccountId) ? input.identityAccountId : refuse("IDENTITY_ACCOUNT_REQUIRED");
  } else if (has("identityAccountId")) refuse("UNEXPECTED_FIELD", "identityAccountId");
  if (action === "RELEASE_DOMAIN") {
    result.domain = normalizeDomain(input.domain) ?? refuse("DOMAIN_REQUIRED");
  } else if (has("domain")) refuse("UNEXPECTED_FIELD", "domain");
  if (action === "RECOVERY_INVITATION") {
    // D3: only for the person explicitly named in a written, verified customer request.
    if (type !== "VERIFIED_CUSTOMER_REQUEST") refuse("AUTHORITY_REFUSED", "RECOVERY_INVITATION needs a VERIFIED_CUSTOMER_REQUEST");
    result.namedPerson = text(input.namedPerson, 2, 120) ?? refuse("NAMED_PERSON_REQUIRED");
    if (reference.namedPerson !== result.namedPerson) refuse("NAMED_PERSON_MISMATCH");
  } else if (has("namedPerson")) refuse("UNEXPECTED_FIELD", "namedPerson");
  return result;
}

// ------------------------------------------------------------------------------------------------
// Plan: the exact state, targets and expected result. Same function for the dry run and inside apply.
// ------------------------------------------------------------------------------------------------

export const systemDnsCheck: DnsCheck = async (server, name) => {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers([server]);
  try { return (await resolver.resolveTxt(name)).length ? "PRESENT" : "ABSENT"; }
  catch (error) {
    const code = (error as { code?: string }).code;
    return code === "ENOTFOUND" || code === "ENODATA" ? "ABSENT" : "UNKNOWN";
  }
};

type Counts = {
  openSessions: number; activeAccounts: number; activeLocalIdentities: number; activePasskeys: number;
  openInvitations: number; heldDomains: number; durableAdministrators: number; administratorsAbleToSignIn: number;
};

async function readCounts(tx: Tx, organizationId: string, tenantId: string, at: Date): Promise<Counts> {
  const where = { organizationId };
  const durable = await tx.subject.findMany({ where: durableAdministratorWhere({ organizationId, tenantId }, at), select: { id: true } });
  // A durable administrator can sign in through an ACTIVE account: Microsoft (the provider decides),
  // or LUXIA local with a usable local identity and at least one active passkey or security key.
  const accounts = durable.length ? await tx.identityAccount.findMany({
    where: { organizationId, tenantId, subjectId: { in: durable.map((s) => s.id) }, status: "ACTIVE" },
    select: { subjectId: true, providerConnection: { select: { providerType: true } },
      localIdentity: { select: { status: true, lockedUntil: true, authenticators: { where: { status: "ACTIVE", type: { in: ["PASSKEY", "SECURITY_KEY"] }, credentialId: { not: null } }, select: { id: true } } } } },
  }) : [];
  const ableToSignIn = new Set(accounts.filter((account) => {
    if (account.providerConnection.providerType !== "LUXIA_LOCAL") return true;
    const local = account.localIdentity;
    const usable = local && (local.status === "ACTIVE" || (local.status === "LOCKED" && local.lockedUntil !== null && local.lockedUntil <= at));
    return Boolean(usable && local.authenticators.length);
  }).map((account) => account.subjectId));
  return {
    openSessions: await tx.session.count({ where: { ...where, revokedAt: null } }),
    activeAccounts: await tx.identityAccount.count({ where: { ...where, status: "ACTIVE" } }),
    activeLocalIdentities: await tx.localIdentity.count({ where: { ...where, status: "ACTIVE" } }),
    activePasskeys: await tx.localAuthenticator.count({ where: { ...where, status: "ACTIVE" } }),
    openInvitations: await tx.invitation.count({ where: { ...where, acceptedAt: null, revokedAt: null } }),
    heldDomains: await tx.organizationDomain.count({ where: { ...where, status: { in: ["PENDING", "VERIFIED"] } } }),
    durableAdministrators: durable.length,
    administratorsAbleToSignIn: ableToSignIn.size,
  };
}

export type BreakGlassPlan = {
  version: 1;
  toolVersion: string;
  /** Where this plan may be applied: a digest made against another database does not match. */
  binding: { endpoint: string | null; database: string; role: string };
  input: BreakGlassInput;
  organization: { id: string; slug: string; status: OrganizationStatus; statusChangedAt: string | null };
  tenantId: string;
  counts: Counts;
  target: Record<string, Json> | null;
  operatorSubjectId: string | null;
  unjournaledStatusChange: { status: string; at: string } | null;
  expected: Record<string, Json>;
  irreversible: boolean;
  issuedAt: string;
  notAfter: string;
};

export async function computePlan(tx: Tx, input: BreakGlassInput, options: BreakGlassOptions): Promise<{ plan: BreakGlassPlan; digest: string }> {
  const at = options.issuedAt;
  const [connection] = await tx.$queryRaw<Array<{ database: string; role: string }>>`SELECT current_database() AS database, current_user AS role`;
  const org = await tx.organization.findUnique({ where: { slug: input.organization }, select: { id: true, slug: true, status: true, statusChangedAt: true } });
  if (!org) refuse("ORGANIZATION_NOT_FOUND");
  const status = org.status as OrganizationStatus;
  if (status === "CLOSED") refuse("ORGANIZATION_CLOSED", "nothing is possible on a CLOSED organization");
  const tenants = await tx.tenant.findMany({ where: { organizationId: org.id }, select: { id: true }, orderBy: { id: "asc" } });
  if (tenants.length !== 1) refuse("ONE_TENANT_REQUIRED");
  const tenantId = tenants[0].id;
  const counts = await readCounts(tx, org.id, tenantId, at);

  const operators = await tx.subject.findMany({ where: { organizationId: org.id, tenantId, type: "SERVICE", name: OPERATOR_SUBJECT_NAME },
    select: { id: true, lifecycleState: true, identities: { select: { id: true } }, Assignment: { select: { id: true } } } });
  if (operators.length > 1) refuse("OPERATOR_SUBJECT_AMBIGUOUS");
  const operator = operators[0];
  if (operator && (operator.lifecycleState !== "DISABLED" || operator.identities.length || operator.Assignment.length)) refuse("OPERATOR_SUBJECT_INVALID");

  let unjournaledStatusChange: BreakGlassPlan["unjournaledStatusChange"] = null;
  if (org.statusChangedAt) {
    const last = await tx.canonicalAdminAuditEvent.findFirst({ where: { organizationId: org.id, operation: { startsWith: "BREAK_GLASS.ORGANIZATION." } },
      orderBy: { occurredAt: "desc" }, select: { occurredAt: true } });
    if (!last || last.occurredAt < org.statusChangedAt) unjournaledStatusChange = { status, at: org.statusChangedAt.toISOString() };
  }

  let target: BreakGlassPlan["target"] = null;
  let expected: BreakGlassPlan["expected"];
  const requireStatus = (...allowed: OrganizationStatus[]) => { if (!allowed.includes(status)) refuse("ORGANIZATION_STATUS_REFUSED", `${input.action} needs ${allowed.join(" or ")}, found ${status}`); };
  switch (input.action) {
    case "SUSPEND_ORGANIZATION":
      requireStatus("ACTIVE");
      expected = { status: "SUSPENDED", openSessions: 0 };
      break;
    case "REACTIVATE_ORGANIZATION":
      requireStatus("SUSPENDED");
      expected = { status: "ACTIVE" };
      break;
    case "CLOSE_ORGANIZATION":
      requireStatus("ACTIVE", "SUSPENDED");
      expected = { status: "CLOSED", openSessions: 0, openInvitations: 0, heldDomains: 0 };
      break;
    case "REVOKE_SESSIONS":
      expected = { openSessions: 0 };
      break;
    case "DISABLE_ACCOUNT": {
      const account = await tx.identityAccount.findFirst({ where: { id: input.identityAccountId, organizationId: org.id, tenantId },
        select: { id: true, status: true, subjectId: true, localIdentity: { select: { status: true } } } });
      if (!account) refuse("ACCOUNT_NOT_IN_ORGANIZATION");
      if (account.status !== "ACTIVE") refuse("ACCOUNT_NOT_ACTIVE");
      const durable = await tx.subject.count({ where: { ...durableAdministratorWhere({ organizationId: org.id, tenantId }, at), id: account.subjectId } });
      const otherActive = await tx.identityAccount.count({ where: { organizationId: org.id, tenantId, subjectId: account.subjectId, status: "ACTIVE", id: { not: account.id } } });
      const lastAdministrator = durable === 1 && otherActive === 0 && counts.durableAdministrators === 1;
      // D2: the last durable administrator can be disabled only in an organization already SUSPENDED.
      if (lastAdministrator && status !== "SUSPENDED") refuse("LAST_ADMINISTRATOR_PROTECTED", "suspend the organization first (D2)");
      target = {
        identityAccountId: account.id, subjectId: account.subjectId, localIdentityStatus: account.localIdentity?.status ?? null,
        activePasskeys: await tx.localAuthenticator.count({ where: { organizationId: org.id, identityAccountId: account.id, status: "ACTIVE" } }),
        openSessions: await tx.session.count({ where: { organizationId: org.id, identityAccountId: account.id, revokedAt: null } }),
        durableAdministrator: durable === 1, lastAdministrator,
      };
      expected = { account: { status: "DISABLED", localIdentityStatus: account.localIdentity ? "DISABLED" : null, activePasskeys: 0, openSessions: 0 },
        activeAccounts: counts.activeAccounts - 1 };
      break;
    }
    case "RELEASE_DOMAIN": {
      const domain = await tx.organizationDomain.findFirst({ where: { organizationId: org.id, domain: input.domain }, select: { status: true } });
      if (!domain) refuse("DOMAIN_NOT_IN_ORGANIZATION");
      if (domain.status !== "VERIFIED" && domain.status !== "PENDING") refuse("DOMAIN_NOT_HELD", domain.status);
      const record = `${RECORD_PREFIX}.${input.domain}`;
      const dns: Record<string, string> = {};
      for (const resolver of DNS_RESOLVERS) dns[resolver] = await (options.dns ?? systemDnsCheck)(resolver, record);
      if (Object.values(dns).some((value) => value === "UNKNOWN")) refuse("DNS_CHECK_FAILED");
      if (Object.values(dns).some((value) => value === "PRESENT")) refuse("DNS_RECORD_PRESENT", record);
      target = { domain: input.domain!, status: domain.status, record, dns };
      expected = { domain: { status: domain.status === "VERIFIED" ? "LOST" : "EXPIRED" }, heldDomains: counts.heldDomains - 1 };
      break;
    }
    case "RECOVERY_INVITATION":
      requireStatus("ACTIVE");
      // D3: only if no durable administrator can currently sign in.
      if (counts.administratorsAbleToSignIn > 0) refuse("ADMINISTRATOR_CAN_SIGN_IN", "the customer's administrators can invite (D3)");
      target = { namedPerson: input.namedPerson!, role: "ADMIN", lifetimeHours: 24 };
      expected = { openInvitations: counts.openInvitations + 1 };
      break;
  }

  const plan: BreakGlassPlan = {
    version: 1, toolVersion: options.toolVersion, binding: { endpoint: options.endpoint ?? null, ...connection }, input,
    organization: { id: org.id, slug: org.slug, status, statusChangedAt: org.statusChangedAt?.toISOString() ?? null },
    tenantId, counts, target, operatorSubjectId: operator?.id ?? null, unjournaledStatusChange, expected,
    irreversible: IRREVERSIBLE_ACTIONS.includes(input.action),
    issuedAt: at.toISOString(), notAfter: new Date(at.getTime() + PLAN_VALIDITY_MS).toISOString(),
  };
  return { plan, digest: planDigest(plan) };
}

/** Dry run: READ ONLY, nothing is written. */
export async function planBreakGlass(db: PrismaClient, raw: unknown, options: BreakGlassOptions) {
  const input = validateInput(raw, options.certificationOrganizations);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return computePlan(tx, input, options);
  }, { maxWait: 10_000, timeout: 60_000 });
}

// ------------------------------------------------------------------------------------------------
// Apply: one owner transaction, plan recomputed under the locks, digest compared, then the action.
// ------------------------------------------------------------------------------------------------

export type ApplyOptions = BreakGlassOptions & { confirm: string; irreversible?: string; now?: Date };
export type ApplyResult = {
  digest: string;
  changeId: string;
  action: BreakGlassAction;
  organization: string;
  effects: Record<string, Json>;
  /** RECOVERY_INVITATION only: shown once by the command, never journaled or written to evidence. */
  invitationToken?: string;
  committed: { verified: boolean; observed: Record<string, Json> };
};

async function ensureOperatorSubject(tx: Tx, plan: BreakGlassPlan): Promise<string> {
  if (plan.operatorSubjectId) return plan.operatorSubjectId;
  const created = await tx.subject.create({ data: { organizationId: plan.organization.id, tenantId: plan.tenantId, type: "SERVICE",
    name: OPERATOR_SUBJECT_NAME, lifecycleState: "DISABLED" }, select: { id: true } });
  return created.id;
}

/** D3: the emergency administrator invitation, with authority bound to its break-glass event. */
async function issueRecoveryInvitation(tx: Tx, plan: BreakGlassPlan, operatorSubjectId: string, changeId: string) {
  if (!await lockOrganizationActive(tx, plan.organization.id)) refuse("ORGANIZATION_STATUS_REFUSED", "RECOVERY_INVITATION needs ACTIVE");
  const scope = { organizationId: plan.organization.id, tenantId: plan.tenantId };
  const subject = await tx.subject.create({ data: { ...scope, type: "HUMAN", name: plan.input.namedPerson!, lifecycleState: "PROVISIONING" }, select: { id: true } });
  const token = randomBytes(32).toString("base64url");
  const invitation = await tx.invitation.create({
    data: { ...scope, subjectId: subject.id, tokenHash: createHash("sha256").update(token).digest("hex"), role: "ADMIN",
      invitedBySubjectId: operatorSubjectId, issuedByOperatorChangeId: changeId },
    select: { id: true, expiresAt: true },
  });
  return { effects: { invitationId: invitation.id, subjectId: subject.id, expiresAt: invitation.expiresAt.toISOString() }, targetSubjectId: subject.id, token };
}

async function perform(tx: Tx, plan: BreakGlassPlan, operatorSubjectId: string, changeId: string, now: Date) {
  const organizationId = plan.organization.id;
  const scope = { organizationId, tenantId: plan.tenantId };
  switch (plan.input.action) {
    case "SUSPEND_ORGANIZATION":
    case "REACTIVATE_ORGANIZATION":
    case "CLOSE_ORGANIZATION": {
      const to: OrganizationStatus = plan.input.action === "SUSPEND_ORGANIZATION" ? "SUSPENDED" : plan.input.action === "REACTIVATE_ORGANIZATION" ? "ACTIVE" : "CLOSED";
      const t = await transitionOrganization(tx, organizationId, to);
      return { effects: { from: t.from, to: t.to, revokedSessions: t.revokedSessions, revokedInvitations: t.revokedInvitations, releasedDomains: t.releasedDomains } };
    }
    case "REVOKE_SESSIONS": {
      const revoked = await tx.session.updateMany({ where: { organizationId, revokedAt: null }, data: { revokedAt: now } });
      return { effects: { revokedSessions: revoked.count } };
    }
    case "DISABLE_ACCOUNT": {
      const id = plan.input.identityAccountId!;
      // B1 for ACTIVE organizations; D2 lets an already SUSPENDED one lose its last administrator.
      const effects = await preserveLastAdministratorUnlessSuspended(tx, scope, async () => {
        const account = await tx.identityAccount.updateMany({ where: { id, organizationId, status: "ACTIVE" }, data: { status: "DISABLED", disabledAt: now } });
        if (account.count !== 1) refuse("ACCOUNT_NOT_ACTIVE");
        const local = await tx.localIdentity.updateMany({ where: { organizationId, identityAccountId: id, status: { not: "DISABLED" } }, data: { status: "DISABLED" } });
        const passkeys = await tx.localAuthenticator.updateMany({ where: { organizationId, identityAccountId: id, status: "ACTIVE" },
          data: { status: "REVOKED", revokedAt: now, stateVersion: { increment: 1 } } });
        const sessions = await tx.session.updateMany({ where: { organizationId, identityAccountId: id, revokedAt: null }, data: { revokedAt: now } });
        return { identityAccountId: id, localIdentityDisabled: local.count === 1, passkeysRevoked: passkeys.count, sessionsRevoked: sessions.count };
      });
      return { effects, targetSubjectId: String(plan.target?.subjectId) };
    }
    case "RELEASE_DOMAIN": {
      const from = String(plan.target?.status);
      const to = from === "VERIFIED" ? "LOST" : "EXPIRED";
      const released = await tx.organizationDomain.updateMany({ where: { organizationId, domain: plan.input.domain, status: from as "VERIFIED" | "PENDING" },
        data: { status: to, lastCheckedAt: now } });
      if (released.count !== 1) refuse("DOMAIN_NOT_HELD");
      return { effects: { domain: plan.input.domain!, from, to } };
    }
    case "RECOVERY_INVITATION":
      return issueRecoveryInvitation(tx, plan, operatorSubjectId, changeId);
  }
}

/** Event metadata: references, verification, digest and counts. Never a token, link, code or secret. */
function eventMetadata(plan: BreakGlassPlan, digest: string, effects: Record<string, Json>): Prisma.InputJsonObject {
  return JSON.parse(canonicalJson({
    breakGlass: true, action: plan.input.action, planDigest: digest, toolVersion: plan.toolVersion,
    reference: plan.input.reference, reason: plan.input.reason,
    targets: { identityAccountId: plan.input.identityAccountId, domain: plan.input.domain, namedPerson: plan.input.namedPerson },
    before: plan.counts, expected: plan.expected, effects, unjournaledStatusChange: plan.unjournaledStatusChange,
    ...(plan.input.action === "RECOVERY_INVITATION" ? { invitationId: effects.invitationId } : {}),
  }));
}

/** Committed state after apply (finding P1: only a re-read proves the transaction committed). */
async function readCommitted(db: PrismaClient, plan: BreakGlassPlan): Promise<{ verified: boolean; observed: Record<string, Json> }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const org = await tx.organization.findUniqueOrThrow({ where: { id: plan.organization.id }, select: { status: true } });
    const counts = await readCounts(tx, plan.organization.id, plan.tenantId, new Date());
    const observed: Record<string, Json> = { status: org.status, ...counts };
    if (plan.input.action === "DISABLE_ACCOUNT") {
      const id = plan.input.identityAccountId!;
      const account = await tx.identityAccount.findFirstOrThrow({ where: { id, organizationId: plan.organization.id }, select: { status: true, localIdentity: { select: { status: true } } } });
      observed.account = {
        status: account.status, localIdentityStatus: account.localIdentity?.status ?? null,
        activePasskeys: await tx.localAuthenticator.count({ where: { organizationId: plan.organization.id, identityAccountId: id, status: "ACTIVE" } }),
        openSessions: await tx.session.count({ where: { organizationId: plan.organization.id, identityAccountId: id, revokedAt: null } }),
      };
    }
    if (plan.input.action === "RELEASE_DOMAIN") {
      const domain = await tx.organizationDomain.findFirstOrThrow({ where: { organizationId: plan.organization.id, domain: plan.input.domain }, select: { status: true } });
      observed.domain = { status: domain.status };
    }
    const matches = (expected: Json, value: Json): boolean => expected !== null && typeof expected === "object" && !Array.isArray(expected)
      ? value !== null && typeof value === "object" && !Array.isArray(value) && Object.entries(expected).every(([k, v]) => matches(v, (value as Record<string, Json>)[k]))
      : expected === value;
    return { verified: matches(plan.expected, observed), observed };
  }, { maxWait: 10_000, timeout: 60_000 });
}

export async function applyBreakGlass(db: PrismaClient, raw: unknown, options: ApplyOptions): Promise<ApplyResult> {
  const now = options.now ?? new Date();
  if (now.getTime() > options.issuedAt.getTime() + PLAN_VALIDITY_MS) refuse("PLAN_EXPIRED", "plan again (D5)");
  if (!/^[0-9a-f]{64}$/.test(options.confirm)) refuse("CONFIRMATION_REQUIRED");
  const input = validateInput(raw, options.certificationOrganizations);
  if (IRREVERSIBLE_ACTIONS.includes(input.action) && options.irreversible !== input.organization)
    refuse("IRREVERSIBLE_CONFIRMATION_REQUIRED", "type the exact organization identifier (D4)");

  const applied = await db.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({ where: { slug: input.organization }, select: { id: true } });
    if (!org) refuse("ORGANIZATION_NOT_FOUND");
    // Lock order of B1 and B3: governance lock of every tenant, then the organization row.
    const tenants = await tx.tenant.findMany({ where: { organizationId: org.id }, select: { id: true }, orderBy: { id: "asc" } });
    for (const tenant of tenants) await lockTenantGovernance(tx, { organizationId: org.id, tenantId: tenant.id });
    await tx.$queryRaw`SELECT 1 FROM "Organization" WHERE "id" = ${org.id} FOR UPDATE`;
    // The plan is recomputed from the same inputs and the current state: a different input, a changed
    // state or another tool version gives another digest, and nothing is written (invariant, D5).
    const { plan, digest } = await computePlan(tx, input, options);
    if (digest !== options.confirm) refuse("DIGEST_MISMATCH", "the state or the inputs changed since the dry run: plan again");
    const operatorSubjectId = await ensureOperatorSubject(tx, plan);
    const changeId = `break-glass:${digest}`;
    const done = await perform(tx, plan, operatorSubjectId, changeId, now);
    const { token, ...rest } = done as { effects: Record<string, Json>; targetSubjectId?: string; token?: string };
    // The event time is the database transaction time, the instant and clock of the status trigger's
    // statusChangedAt, never the operator machine's clock (Prisma's default): a status change made by
    // this procedure then reads as journaled in every later plan (unjournaledStatusChange).
    const [{ at: occurredAt }] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS at`;
    // D6: one plan applies at most once; the unique changeId of the journal refuses a replay.
    await tx.canonicalAdminAuditEvent.create({ data: {
      organizationId: plan.organization.id, tenantId: plan.tenantId, actorSubjectId: operatorSubjectId, targetSubjectId: rest.targetSubjectId ?? null,
      operation: JOURNAL_OPERATION[plan.input.action], result: "SUCCESS", changeId, metadata: eventMetadata(plan, digest, rest.effects), occurredAt,
    } });
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return { plan, digest, changeId, effects: rest.effects, token };
  }, { maxWait: 10_000, timeout: 60_000 }).catch((error: unknown) => {
    if ((error as { code?: string })?.code === "P2002") refuse("ALREADY_APPLIED", "this plan was applied already (unique changeId)");
    throw error;
  });

  const committed = await readCommitted(db, applied.plan);
  return { digest: applied.digest, changeId: applied.changeId, action: input.action, organization: input.organization,
    effects: applied.effects, invitationToken: applied.token, committed };
}
