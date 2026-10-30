// R7 (docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md): erasure of a CLOSED organization, at the end of a
// pilot or after its closure. Operator procedure, the same discipline as break-glass (B4): a plan that writes
// nothing and counts the rows per table, its digest as the confirmation, the organization identifier typed, a
// 15-minute validity, the same database and tool commit. Apply refuses if any count changed since the plan, runs
// the database function (prisma/migrations/20261023140000_organization_erasure) in one transaction, and commits
// only if the function deleted exactly the planned rows. Evidence holds identifiers and counts, never row content.
import type { PrismaClient } from "@prisma/client";
import { canonicalJson, planDigest } from "./break-glass";

/**
 * Children first. Kept identical to the array in the migration (architecture test). LegacyUserBridge is deliberately
 * absent: an organization that has one is refused, and the erasure must never remove that link.
 */
export const ERASURE_TABLES = [
  "AccessReviewItem", "AccessReviewCampaign", "SoDRule", "SoDPolicy", "Assignment", "Entitlement",
  "ResourceScopeMember", "ResourceScope", "ProviderSecretReference", "ProviderConnectionTenantScope", "Resource",
  "Session", "AuthenticationEvidence", "LocalAuthChallenge", "LocalRecoveryCode", "LocalAuthenticator", "LocalIdentity",
  "Invitation", "IdentityRecoveryApproval", "IdentityRecoveryCeremony", "IdentityPortabilityConflict",
  "IdentityPortabilityReceipt", "CredentialReenrollmentRequirement", "IdentityContinuityConflict",
  "IdentityContinuityEvent", "IdentityAssuranceSnapshot", "OfflineIdentityChallenge", "IdentityContinuityState",
  "TrustAnchorVersion", "CryptoKeyVersion", "ProviderIdentityCollision", "IdentityAccount",
  "AuthorizationShadowObservation", "CanonicalAdminAuditEvent", "OrganizationDomain", "Subject", "ProviderConnection",
  "Tenant", "SignupCode",
] as const;
export const ERASURE_PLAN_VALIDITY_MS = 15 * 60_000;

export class ErasureRefusal extends Error {}
const refuse = (code: string): never => { throw new ErasureRefusal(code); };

export type ErasureTarget = { host: string; database: string; role: string };
/** The endpoint a plan is bound to: host and port, so another database on the same host does not match. */
export const erasureEndpoint = (url: string) => new URL(url).host;
export type ErasureCounts = Record<string, number>;
export type ErasurePlan = {
  kind: "LUXIA_ORGANIZATION_ERASURE_PLAN";
  organization: { id: string; slug: string; status: "CLOSED"; statusChangedAt: string | null };
  counts: ErasureCounts;
  /** Precondition (no bridge for this organization) and what the erasure cannot see: legacy users with no bridge, in the whole database. */
  legacy: { bridgesForOrganization: 0; usersWithoutBridge: number };
  target: ErasureTarget; toolVersion: string; issuedAt: string; notAfter: string;
};

/** Legacy users linked to no organization. They carry no organization, so no erasure can attribute or remove them. */
export async function countLegacyUsersWithoutBridge(db: Pick<PrismaClient, "$queryRawUnsafe">): Promise<number> {
  const [row] = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "User" u WHERE NOT EXISTS (SELECT 1 FROM "LegacyUserBridge" b WHERE b."legacyUserId" = u."id")`);
  return row.n;
}

/** Rows of the organization per table, as the database function will delete them. Table names are constants. */
export async function countOrganizationRows(db: Pick<PrismaClient, "$queryRawUnsafe">, organizationId: string): Promise<ErasureCounts> {
  const counts: ErasureCounts = {};
  for (const table of ERASURE_TABLES) {
    const [row] = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table}" WHERE "organizationId" = $1`, organizationId);
    counts[table] = row.n;
  }
  const [transactions] = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "AuthTransaction" WHERE "expectedOrganizationId" = $1`, organizationId);
  counts.AuthTransaction = transactions.n;
  counts.Organization = 1;
  return counts;
}

export async function planErasure(db: PrismaClient, slug: string | undefined, target: ErasureTarget, toolVersion: string, now = new Date()) {
  if (!slug) refuse("ORGANIZATION_REQUIRED");
  if (!/^[0-9a-f]{40}$/.test(toolVersion)) refuse("TOOL_VERSION_UNKNOWN");
  const organization = await db.organization.findUnique({ where: { slug: slug! }, select: { id: true, slug: true, status: true, statusChangedAt: true } });
  if (!organization) refuse("ORGANIZATION_UNKNOWN");
  if (organization!.status !== "CLOSED") refuse("ORGANIZATION_NOT_CLOSED");
  // Legacy tables have no organization column; the bridge is their only link. The database refuses too.
  if (await db.legacyUserBridge.count({ where: { organizationId: organization!.id } }) > 0) refuse("LEGACY_DATA_PRESENT");
  const plan: ErasurePlan = {
    kind: "LUXIA_ORGANIZATION_ERASURE_PLAN",
    organization: { id: organization!.id, slug: organization!.slug, status: "CLOSED", statusChangedAt: organization!.statusChangedAt?.toISOString() ?? null },
    counts: await countOrganizationRows(db, organization!.id),
    legacy: { bridgesForOrganization: 0, usersWithoutBridge: await countLegacyUsersWithoutBridge(db) }, target, toolVersion,
    issuedAt: now.toISOString(), notAfter: new Date(now.getTime() + ERASURE_PLAN_VALIDITY_MS).toISOString(),
  };
  return { plan, digest: planDigest(plan) };
}

/** Refuses unless the saved plan is intact, confirmed by its digest and the typed identifier, fresh, and for this database and commit. */
export function checkErasurePlan(saved: unknown, confirm: string | undefined, typed: string | undefined,
  current: { target: ErasureTarget; toolVersion: string }, now = new Date()): ErasurePlan {
  const file = saved as { plan?: ErasurePlan; digest?: string } | null;
  if (!file?.plan || file.plan.kind !== "LUXIA_ORGANIZATION_ERASURE_PLAN") refuse("NOT_AN_ERASURE_PLAN");
  const plan = file!.plan!;
  if (planDigest(plan) !== file!.digest) refuse("PLAN_TAMPERED");
  if (!confirm || confirm !== file!.digest) refuse("CONFIRMATION_MISMATCH");
  if (!typed || typed !== plan.organization.slug) refuse("IRREVERSIBLE_CONFIRMATION_REQUIRED");
  if (!(now.getTime() <= Date.parse(plan.notAfter))) refuse("PLAN_EXPIRED");
  if (canonicalJson(plan.target) !== canonicalJson(current.target)) refuse("TARGET_MISMATCH");
  if (plan.toolVersion !== current.toolVersion) refuse("TOOL_VERSION_MISMATCH");
  return plan;
}

/** One transaction: recount, erase, compare; anything unexpected rolls everything back. */
export async function applyErasure(db: PrismaClient, plan: ErasurePlan) {
  return db.$transaction(async (tx) => {
    const current = await countOrganizationRows(tx, plan.organization.id);
    if (canonicalJson(current) !== canonicalJson(plan.counts)) refuse("PLAN_STALE");
    const [row] = await tx.$queryRaw<Array<{ counts: ErasureCounts }>>`SELECT luxia_organization_erase(${plan.organization.id}) AS counts`;
    if (canonicalJson(row.counts) !== canonicalJson(plan.counts)) refuse("ERASURE_RESULT_MISMATCH");
    const remaining = await tx.organization.count({ where: { id: plan.organization.id } });
    if (remaining !== 0) refuse("ERASURE_RESULT_MISMATCH");
    return { organizationId: plan.organization.id, slug: plan.organization.slug, counts: row.counts, legacyUsersWithoutBridge: await countLegacyUsersWithoutBridge(tx) };
  }, { timeout: 120_000, maxWait: 10_000 });
}
