import type { Prisma } from "@prisma/client";
import { CanonicalAdminError } from "./canonical-admin-error";

// First Admin / Break-glass v1, B1 (docs/product/FIRST-ADMIN-BREAK-GLASS-V1-SCOPE.md). Administrative
// continuity: no change may take a tenant from at least one durable administrator to none.
//
// A durable administrator is a HUMAN subject in the ACTIVE lifecycle, with at least one ACTIVE identity
// account of its own, holding a native `assignments.manage` grant that is effective now and has no end
// date. It is narrower than "has administrator rights": a temporary administrator is functionally an
// administrator, but cannot satisfy this invariant because the grant removes itself when it expires.
// LEGACY_ROLE grants never count (same rule as requireNative).
export const ADMINISTRATOR_ENTITLEMENT = "assignments.manage";
export const LAST_ADMINISTRATOR_PROTECTED = "LAST_ADMINISTRATOR_PROTECTED";

type Scope = { organizationId: string; tenantId: string };

export function durableAdministratorWhere(scope: Scope, now: Date): Prisma.SubjectWhereInput {
  return {
    organizationId: scope.organizationId, tenantId: scope.tenantId, type: "HUMAN", lifecycleState: "ACTIVE",
    // `identities` joins on (organizationId, tenantId, subjectId): only this subject's own accounts.
    identities: { some: { organizationId: scope.organizationId, tenantId: scope.tenantId, status: "ACTIVE" } },
    Assignment: { some: {
      organizationId: scope.organizationId, tenantId: scope.tenantId,
      status: "ACTIVE", source: { not: "LEGACY_ROLE" }, validUntil: null,
      OR: [{ validFrom: null }, { validFrom: { lte: now } }],
      entitlement: { key: ADMINISTRATOR_ENTITLEMENT, active: true, resourceScopeId: null },
    } },
  };
}

export function countDurableAdministrators(tx: Prisma.TransactionClient, scope: Scope, now = new Date()) {
  return tx.subject.count({ where: durableAdministratorWhere(scope, now) });
}

/**
 * The tenant governance lock. The SoD trigger takes the same lock on every Assignment write, and every
 * governance writer takes it first. With one lock taken before any row lock, every path acquires locks
 * in the same order, so the guard cannot deadlock with them.
 */
export async function lockTenantGovernance(tx: Prisma.TransactionClient, scope: Scope) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${scope.organizationId}:${scope.tenantId}`}, 0))::text`;
}

/**
 * Runs `change` in the caller's transaction and refuses it if it would take the tenant from at least one
 * durable administrator to none. A tenant already at none is not blocked, so it can be repaired. Counts
 * are read after the lock: under READ COMMITTED they include every change committed by an earlier holder,
 * so two concurrent removals cannot both pass. A refused change is rolled back to a savepoint, which lets
 * the caller commit its DENIED audit event in the same transaction.
 */
export async function preserveLastAdministrator<T>(tx: Prisma.TransactionClient, scope: Scope, change: () => Promise<T>): Promise<T> {
  await lockTenantGovernance(tx, scope);
  const now = new Date();
  const before = await countDurableAdministrators(tx, scope, now);
  await tx.$executeRaw`SAVEPOINT luxia_last_administrator`;
  const value = await change();
  const after = await countDurableAdministrators(tx, scope, now);
  if (before > 0 && after === 0) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT luxia_last_administrator`;
    throw new CanonicalAdminError(LAST_ADMINISTRATOR_PROTECTED, 409);
  }
  await tx.$executeRaw`RELEASE SAVEPOINT luxia_last_administrator`;
  return value;
}
