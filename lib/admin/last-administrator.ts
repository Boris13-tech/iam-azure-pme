import type { Prisma } from "@prisma/client";
import { CanonicalAdminError } from "./canonical-admin-error";

// First Admin / Break-glass v1, B1 (docs/product/FIRST-ADMIN-BREAK-GLASS-V1-SCOPE.md). No change may
// leave a tenant without an active administrator.
//
// An active administrator is a HUMAN subject in the ACTIVE lifecycle, with at least one ACTIVE identity
// account, holding a native `assignments.manage` grant that is effective now and has no end date.
// LEGACY_ROLE grants never count (same rule as requireNative). A grant with an end date does not count
// either: it would remove the last administrator on its own when it expires.
export const ADMINISTRATOR_ENTITLEMENT = "assignments.manage";
export const LAST_ADMINISTRATOR_PROTECTED = "LAST_ADMINISTRATOR_PROTECTED";

type Scope = { organizationId: string; tenantId: string };

export function activeAdministratorWhere(scope: Scope, now: Date): Prisma.SubjectWhereInput {
  return {
    organizationId: scope.organizationId, tenantId: scope.tenantId, type: "HUMAN", lifecycleState: "ACTIVE",
    identities: { some: { status: "ACTIVE" } },
    Assignment: { some: {
      status: "ACTIVE", source: { not: "LEGACY_ROLE" }, validUntil: null,
      OR: [{ validFrom: null }, { validFrom: { lte: now } }],
      entitlement: { key: ADMINISTRATOR_ENTITLEMENT, active: true, resourceScopeId: null },
    } },
  };
}

export function countActiveAdministrators(tx: Prisma.TransactionClient, scope: Scope, now = new Date()) {
  return tx.subject.count({ where: activeAdministratorWhere(scope, now) });
}

/** Every change that can remove an administrator holds this lock until its transaction ends. */
export async function lockAdministrators(tx: Prisma.TransactionClient, scope: Scope) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`administrators:${scope.organizationId}:${scope.tenantId}`}, 0))::text`;
}

/**
 * Runs `change` in the caller's transaction and refuses it if it would take the tenant from at least one
 * active administrator to none. Counts are read after the lock: under READ COMMITTED they include every
 * change committed by an earlier holder, so two concurrent removals cannot both pass. A refused change is
 * rolled back to a savepoint, which lets the caller commit its DENIED audit event in the same transaction.
 */
export async function preserveLastAdministrator<T>(tx: Prisma.TransactionClient, scope: Scope, change: () => Promise<T>): Promise<T> {
  await lockAdministrators(tx, scope);
  const now = new Date();
  const before = await countActiveAdministrators(tx, scope, now);
  await tx.$executeRaw`SAVEPOINT luxia_last_administrator`;
  const value = await change();
  const after = await countActiveAdministrators(tx, scope, now);
  if (before > 0 && after === 0) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT luxia_last_administrator`;
    throw new CanonicalAdminError(LAST_ADMINISTRATOR_PROTECTED, 409);
  }
  await tx.$executeRaw`RELEASE SAVEPOINT luxia_last_administrator`;
  return value;
}
