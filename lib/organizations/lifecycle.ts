import type { Prisma, PrismaClient } from "@prisma/client";
import { lockTenantGovernance } from "../admin/last-administrator";

// First Admin / Break-glass v1, B3: organization lifecycle enforcement.
// Design: docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-MIGRATION-DESIGN.md (sections 4 and 7).
export type OrganizationStatus = "ACTIVE" | "SUSPENDED" | "CLOSED";
export const ORGANIZATION_NOT_ACTIVE = "ORGANIZATION_NOT_ACTIVE";

/**
 * Share-locks the organization row and tells whether it is ACTIVE. Every transaction that creates a
 * session, an invitation or a domain, or starts, accepts or verifies one, calls it before its first
 * write (after the tenant governance lock when it takes one). The lock holds a status transition back
 * until the transaction ends, so the answer stays true until commit. It never raises: the caller
 * answers with its own generic refusal and the transaction stays usable (for example for an audit).
 */
export async function lockOrganizationActive(tx: Prisma.TransactionClient, organizationId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status"::text AS status FROM "Organization" WHERE "id" = ${organizationId} FOR SHARE`;
  return rows[0]?.status === "ACTIVE";
}

/**
 * F2 kill switch: share-locks the connection of an identity account and tells whether it is ACTIVE. Called
 * after lockOrganizationActive (same lock order as the database trigger). A status change waits until the
 * sign-in transaction ends, so a quarantine then sees, and revokes, the session it created. Never raises.
 */
export async function lockProviderConnectionActive(tx: Prisma.TransactionClient, organizationId: string, identityAccountId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT pc."status"::text AS status FROM "IdentityAccount" ia
    JOIN "ProviderConnection" pc ON pc."organizationId" = ia."organizationId" AND pc."id" = ia."providerConnectionId"
    WHERE ia."organizationId" = ${organizationId} AND ia."id" = ${identityAccountId}
    FOR SHARE OF pc`;
  return rows[0]?.status === "ACTIVE";
}

/**
 * F2 quarantine effect, in the caller's transaction (the connection row already locked and set QUARANTINED):
 * revokes every open session opened through the connection, in the caller's tenant scope. A session of another
 * tenant would be left open, and the deferred completeness check then fails the whole transaction.
 */
export async function revokeProviderConnectionSessions(tx: Prisma.TransactionClient, organizationId: string, providerConnectionId: string): Promise<number> {
  return tx.$executeRaw`UPDATE "Session" s SET "revokedAt" = (now() AT TIME ZONE 'UTC')
    FROM "IdentityAccount" ia
    WHERE ia."organizationId" = s."organizationId" AND ia."id" = s."identityAccountId"
      AND s."organizationId" = ${organizationId} AND ia."providerConnectionId" = ${providerConnectionId} AND s."revokedAt" IS NULL`;
}

type Counts = { openSessions: number; openInvitations: number; heldDomains: number };
export type OrganizationTransition = {
  organizationId: string; from: OrganizationStatus; to: OrganizationStatus; before: Counts; after: Counts;
  revokedSessions: number; revokedInvitations: number; releasedDomains: number;
};

async function counts(tx: Prisma.TransactionClient, organizationId: string): Promise<Counts> {
  const [row] = await tx.$queryRaw<Array<Counts>>`SELECT
    (SELECT count(*)::int FROM "Session" WHERE "organizationId" = ${organizationId} AND "revokedAt" IS NULL) AS "openSessions",
    (SELECT count(*)::int FROM "Invitation" WHERE "organizationId" = ${organizationId} AND "acceptedAt" IS NULL AND "revokedAt" IS NULL) AS "openInvitations",
    (SELECT count(*)::int FROM "OrganizationDomain" WHERE "organizationId" = ${organizationId} AND "status" IN ('PENDING', 'VERIFIED')) AS "heldDomains"`;
  return row;
}

/**
 * Operator-only primitive for a status change, run inside one transaction with the owner connection
 * (the database refuses a status change from any other role). The B4 procedure wraps it with its dry
 * run, plan digest, confirmation and journal event; no route or page calls it.
 *  1. the governance lock of every tenant, first (A1);
 *  2. the status (the row lock holds sign-ins, invitations and domains back until commit);
 *  3. the effects, in the same transaction: SUSPENDED and CLOSED revoke every active session at once;
 *     CLOSED also revokes the open invitations and releases the domains (VERIFIED to LOST, PENDING to
 *     EXPIRED). Reactivation has no effect: revoked sessions are frozen and never come back;
 *  4. SET CONSTRAINTS ALL IMMEDIATE, so that an incomplete transition fails here. Prisma 5 does not
 *     report a failed COMMIT (finding P1): the caller re-reads with readOrganizationLifecycle.
 * CLOSED is final: the database refuses any later change.
 */
export async function transitionOrganization(tx: Prisma.TransactionClient, organizationId: string, to: OrganizationStatus): Promise<OrganizationTransition> {
  const tenants = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Tenant" WHERE "organizationId" = ${organizationId} ORDER BY "id"`;
  for (const tenant of tenants) await lockTenantGovernance(tx, { organizationId, tenantId: tenant.id });
  const [current] = await tx.$queryRaw<Array<{ status: OrganizationStatus }>>`SELECT "status"::text AS status FROM "Organization" WHERE "id" = ${organizationId}`;
  if (!current) throw new Error("ORGANIZATION_NOT_FOUND");
  const before = await counts(tx, organizationId);
  await tx.$executeRaw`UPDATE "Organization" SET "status" = ${to}::"OrganizationStatus" WHERE "id" = ${organizationId}`;
  let revokedSessions = 0, revokedInvitations = 0, releasedDomains = 0;
  if (to !== "ACTIVE") {
    revokedSessions = await tx.$executeRaw`UPDATE "Session" SET "revokedAt" = (now() AT TIME ZONE 'UTC')
      WHERE "organizationId" = ${organizationId} AND "revokedAt" IS NULL`;
  }
  if (to === "CLOSED") {
    revokedInvitations = await tx.$executeRaw`UPDATE "Invitation" SET "revokedAt" = (now() AT TIME ZONE 'UTC'), "pendingChallengeHash" = NULL, "pendingExpiresAt" = NULL
      WHERE "organizationId" = ${organizationId} AND "acceptedAt" IS NULL AND "revokedAt" IS NULL`;
    releasedDomains = await tx.$executeRaw`UPDATE "OrganizationDomain"
      SET "status" = CASE WHEN "status" = 'VERIFIED' THEN 'LOST'::"OrganizationDomainStatus" ELSE 'EXPIRED'::"OrganizationDomainStatus" END
      WHERE "organizationId" = ${organizationId} AND "status" IN ('PENDING', 'VERIFIED')`;
  }
  await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
  return { organizationId, from: current.status, to, before, after: await counts(tx, organizationId), revokedSessions, revokedInvitations, releasedDomains };
}

/** Committed state, read after a transition: the only proof that it was applied (finding P1). */
export async function readOrganizationLifecycle(client: PrismaClient, organizationId: string) {
  return client.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ status: OrganizationStatus; statusChangedAt: Date | null }>>`
      SELECT "status"::text AS status, "statusChangedAt" FROM "Organization" WHERE "id" = ${organizationId}`;
    return row ? { ...row, ...(await counts(tx, organizationId)) } : null;
  });
}
