import { createHash } from "node:crypto";
import type { Prisma, ProviderConnectionStatus } from "@prisma/client";
import type { AuthContext } from "../auth/authorization-engine";
import { revokeProviderConnectionSessions } from "../organizations/lifecycle";
import { operation } from "../resources/service";
import { CanonicalAdminError } from "./canonical-admin-error";

// Sovereign Provider & Federation Layer, phase F2: the kill switch an organization administrator holds.
// Design: docs/architecture/F2-PROVIDER-CONNECTION-LIFECYCLE.md. The database enforces the same rules
// (20261014090000): allowed transitions only, under the governance lock, LUXIA_LOCAL always ACTIVE, and a
// quarantine that leaves no open session. This module adds the dry run (D3), the plan digest and the journal.
// Every refusal is decided before the first write, so its DENIED event commits alone.
// TESTING to ACTIVE follows a real connection test (F4) and is not offered here.
export const CONNECTION_ACTIONS = {
  DISABLE: { from: ["ACTIVE"], to: "DISABLED" },
  ACTIVATE: { from: ["DISABLED"], to: "ACTIVE" },
  QUARANTINE: { from: ["ACTIVE", "DISABLED"], to: "QUARANTINED" },
  RELEASE: { from: ["QUARANTINED"], to: "DISABLED" },
} as const satisfies Record<string, { from: readonly ProviderConnectionStatus[]; to: ProviderConnectionStatus }>;
export type ConnectionAction = keyof typeof CONNECTION_ACTIONS;

type Target = { id: string; providerType: string; status: ProviderConnectionStatus; statusChangedAt: Date | null };
export type ConnectionPlan = {
  providerConnectionId: string; action: ConnectionAction; from: ProviderConnectionStatus; to: ProviderConnectionStatus;
  /** Open sessions opened through this connection; a quarantine revokes them all, other actions none. */
  openSessions: number; sessionsToRevoke: number; planDigest: string;
};
export type ConnectionTransition = Omit<ConnectionPlan, "planDigest" | "sessionsToRevoke"> & { revokedSessions: number; statusChangedAt: string };

/** Digest of the exact state a plan was computed on. Applying requires the same state: no blind, no stale change. */
export function connectionPlanDigest(auth: Pick<AuthContext, "organizationId" | "tenantId">, target: Pick<Target, "id" | "status" | "statusChangedAt">, action: ConnectionAction): string {
  return createHash("sha256").update(JSON.stringify({
    v: 1, organizationId: auth.organizationId, tenantId: auth.tenantId, providerConnectionId: target.id, action,
    from: target.status, statusChangedAt: target.statusChangedAt?.toISOString() ?? null,
  })).digest("hex");
}

/** The connection of this organization, in the administrator's tenant scope; row-locked when it is about to change. */
async function readTarget(tx: Prisma.TransactionClient, auth: AuthContext, id: string, lock: boolean): Promise<Target> {
  const rows = lock
    ? await tx.$queryRaw<Target[]>`
      SELECT pc."id", pc."providerType"::text AS "providerType", pc."status"::text AS status, pc."statusChangedAt"
      FROM "ProviderConnection" pc
      JOIN "ProviderConnectionTenantScope" s ON s."organizationId" = pc."organizationId" AND s."providerConnectionId" = pc."id"
      WHERE pc."organizationId" = ${auth.organizationId} AND s."tenantId" = ${auth.tenantId} AND pc."id" = ${id}
      FOR UPDATE OF pc`
    : await tx.$queryRaw<Target[]>`
      SELECT pc."id", pc."providerType"::text AS "providerType", pc."status"::text AS status, pc."statusChangedAt"
      FROM "ProviderConnection" pc
      JOIN "ProviderConnectionTenantScope" s ON s."organizationId" = pc."organizationId" AND s."providerConnectionId" = pc."id"
      WHERE pc."organizationId" = ${auth.organizationId} AND s."tenantId" = ${auth.tenantId} AND pc."id" = ${id}`;
  if (!rows[0]) throw new CanonicalAdminError("PROVIDER_NOT_FOUND", 404);
  return rows[0];
}

function assertAllowed(target: Target, action: ConnectionAction): ProviderConnectionStatus {
  const rule = CONNECTION_ACTIONS[action];
  if (!rule) throw new CanonicalAdminError("INVALID_CONNECTION_ACTION", 400);
  // Rule R3: local sign-in and recovery never depend on a switch.
  if (target.providerType === "LUXIA_LOCAL") throw new CanonicalAdminError("LOCAL_CONNECTION_PROTECTED", 409);
  if (!(rule.from as readonly string[]).includes(target.status)) throw new CanonicalAdminError("CONNECTION_TRANSITION_NOT_ALLOWED", 409);
  return rule.to;
}

async function openSessions(tx: Prisma.TransactionClient, auth: AuthContext, id: string): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM "Session" s
    JOIN "IdentityAccount" ia ON ia."organizationId" = s."organizationId" AND ia."id" = s."identityAccountId"
    WHERE s."organizationId" = ${auth.organizationId} AND ia."providerConnectionId" = ${id} AND s."revokedAt" IS NULL`;
  return row.n;
}

const metadataOf = (target: Target, action: ConnectionAction, to: ProviderConnectionStatus, extra: Record<string, number | string>) =>
  ({ providerConnectionId: target.id, providerType: target.providerType, action, from: target.status, to, ...extra });

/** Dry run (D3): what the action would do, nothing changed. Journaled as a plan; a refusal is journaled as denied. */
export function planConnectionTransition(auth: AuthContext, changeId: string, providerConnectionId: string, action: ConnectionAction): Promise<ConnectionPlan> {
  return operation(auth, changeId, "PROVIDER.CONNECTION.PLAN", "providers.manage", async (tx) => {
    const target = await readTarget(tx, auth, providerConnectionId, false);
    const to = assertAllowed(target, action);
    const open = await openSessions(tx, auth, target.id);
    const sessionsToRevoke = to === "QUARANTINED" ? open : 0;
    const planDigest = connectionPlanDigest(auth, target, action);
    return {
      value: { providerConnectionId: target.id, action, from: target.status, to, openSessions: open, sessionsToRevoke, planDigest },
      metadata: metadataOf(target, action, to, { openSessions: open, sessionsToRevoke, planDigest }),
    };
  });
}

/**
 * Applies a planned action. The plan digest must match the current state. A quarantine revokes every open
 * session opened through the connection, in the same transaction; DISABLE keeps them until they expire (R5).
 * Never deletes a connection, an account, a Subject or an access.
 */
export function applyConnectionTransition(auth: AuthContext, changeId: string, providerConnectionId: string, action: ConnectionAction, planDigest: string): Promise<ConnectionTransition> {
  return operation(auth, changeId, `PROVIDER.CONNECTION.${action}`, "providers.manage", async (tx) => {
    if (!(action in CONNECTION_ACTIONS)) throw new CanonicalAdminError("INVALID_CONNECTION_ACTION", 400);
    const target = await readTarget(tx, auth, providerConnectionId, true);
    const to = assertAllowed(target, action);
    if (planDigest !== connectionPlanDigest(auth, target, action)) throw new CanonicalAdminError("CONNECTION_PLAN_STALE", 409);
    const open = await openSessions(tx, auth, target.id);
    await tx.$executeRaw`UPDATE "ProviderConnection" SET "status" = ${to}::"ProviderConnectionStatus"
      WHERE "organizationId" = ${auth.organizationId} AND "id" = ${target.id}`;
    const revokedSessions = to === "QUARANTINED" ? await revokeProviderConnectionSessions(tx, auth.organizationId, target.id) : 0;
    // Deferred checks now (an incomplete quarantine fails here): Prisma 5 does not report a failed COMMIT.
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    const [changed] = await tx.$queryRaw<Array<{ statusChangedAt: Date }>>`
      SELECT "statusChangedAt" FROM "ProviderConnection" WHERE "organizationId" = ${auth.organizationId} AND "id" = ${target.id}`;
    return {
      value: { providerConnectionId: target.id, action, from: target.status, to, openSessions: open, revokedSessions, statusChangedAt: changed.statusChangedAt.toISOString() },
      metadata: metadataOf(target, action, to, { openSessions: open, revokedSessions, planDigest }),
    };
  });
}
