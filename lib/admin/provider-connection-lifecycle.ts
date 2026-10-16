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
// F4 (S5): the first activation, TESTING to ACTIVE, also needs activation evidence (see activationEvidence).
export const CONNECTION_ACTIONS = {
  DISABLE: { from: ["ACTIVE"], to: "DISABLED" },
  ACTIVATE: { from: ["DISABLED", "TESTING"], to: "ACTIVE" },
  QUARANTINE: { from: ["ACTIVE", "DISABLED"], to: "QUARANTINED" },
  RELEASE: { from: ["QUARANTINED"], to: "DISABLED" },
} as const satisfies Record<string, { from: readonly ProviderConnectionStatus[]; to: ProviderConnectionStatus }>;
export type ConnectionAction = keyof typeof CONNECTION_ACTIONS;

type Target = { id: string; providerType: string; status: ProviderConnectionStatus; statusChangedAt: Date | null };
/**
 * F4 (S5): what a first activation (TESTING to ACTIVE) stands on, all on the connection's CURRENT configuration hash:
 * the latest connection test (DISCOVERY) and the latest proof sign-in (PROOF) both passed, both recent enough, and the
 * proof was made with the secret version still in force.
 */
export type ActivationEvidence = {
  configurationHash: string; discoveryRunId: string; proofRunId: string; proofActorSubjectId: string; secretVersion: string;
};
export type ConnectionPlan = {
  providerConnectionId: string; action: ConnectionAction; from: ProviderConnectionStatus; to: ProviderConnectionStatus;
  /** Open sessions opened through this connection; a quarantine revokes them all, other actions none. */
  openSessions: number; sessionsToRevoke: number; planDigest: string;
  /** First activation only (from TESTING). */
  activationEvidence?: ActivationEvidence;
};
export type ConnectionTransition = Omit<ConnectionPlan, "planDigest" | "sessionsToRevoke"> & { revokedSessions: number; statusChangedAt: string };
export type LifecycleOptions = Readonly<{ now?: () => Date }>;

/**
 * How recent the passing test and the passing proof must be at the first activation. 24 h is engineering's default,
 * pending the operator's decision: a provider can change its keys or metadata between a test and an activation.
 */
export const ACTIVATION_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Digest of the exact state a plan was computed on. Applying requires the same state: no blind, no stale change. */
export function connectionPlanDigest(auth: Pick<AuthContext, "organizationId" | "tenantId">, target: Pick<Target, "id" | "status" | "statusChangedAt">, action: ConnectionAction,
  evidence?: ActivationEvidence): string {
  return createHash("sha256").update(JSON.stringify({
    v: 1, organizationId: auth.organizationId, tenantId: auth.tenantId, providerConnectionId: target.id, action,
    from: target.status, statusChangedAt: target.statusChangedAt?.toISOString() ?? null,
    // Absent for every F2 action, so their digests are unchanged.
    ...(evidence ? { evidence } : {}),
  })).digest("hex");
}

/**
 * F4 (S5): the evidence a first activation needs, read in the caller's transaction (the apply holds the governance lock
 * and the connection's row lock, so nothing can change between this check and the update). Refuses otherwise.
 */
async function activationEvidence(tx: Prisma.TransactionClient, auth: AuthContext, target: Target, now: Date): Promise<ActivationEvidence> {
  if (target.providerType !== "OIDC_GENERIC") throw new CanonicalAdminError("ACTIVATION_UNSUPPORTED", 409);
  const where = { organizationId: auth.organizationId, providerConnectionId: target.id };
  const configuration = await tx.providerOidcConfiguration.findFirst({ where, select: { configurationHash: true } });
  if (!configuration) throw new CanonicalAdminError("ACTIVATION_NOT_CONFIGURED", 409);
  const secret = await tx.providerSecretReference.findFirst({ where: { ...where, purpose: "OIDC_CLIENT", revokedAt: null }, select: { activeVersion: true } });
  if (!secret) throw new CanonicalAdminError("ACTIVATION_SECRET_REQUIRED", 409);
  // The LATEST run of each kind on the current configuration decides: a failure after a success refuses.
  const latest = (kind: "DISCOVERY" | "PROOF") => tx.providerTestRun.findFirst({
    where: { ...where, kind, configurationHash: configuration.configurationHash },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { id: true, outcome: true, occurredAt: true, metadata: true, actorSubjectId: true },
  });
  const usable = (run: { outcome: string; occurredAt: Date }) =>
    run.outcome === "PASSED" && now.getTime() - run.occurredAt.getTime() <= ACTIVATION_EVIDENCE_MAX_AGE_MS;
  const discovery = await latest("DISCOVERY");
  if (!discovery || !usable(discovery)) throw new CanonicalAdminError("ACTIVATION_TEST_REQUIRED", 409);
  const proof = await latest("PROOF");
  if (!proof || !usable(proof)) throw new CanonicalAdminError("ACTIVATION_PROOF_REQUIRED", 409);
  if ((proof.metadata as { secretVersion?: unknown } | null)?.secretVersion !== secret.activeVersion) {
    throw new CanonicalAdminError("ACTIVATION_PROOF_SECRET_CHANGED", 409);
  }
  return { configurationHash: configuration.configurationHash, discoveryRunId: discovery.id, proofRunId: proof.id,
    proofActorSubjectId: proof.actorSubjectId, secretVersion: secret.activeVersion };
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
const firstActivation = (target: Target, to: ProviderConnectionStatus) => target.status === "TESTING" && to === "ACTIVE";
const clock = (options: LifecycleOptions) => (options.now ?? (() => new Date()))();

/** Dry run (D3): what the action would do, nothing changed. Journaled as a plan; a refusal is journaled as denied. */
export function planConnectionTransition(auth: AuthContext, changeId: string, providerConnectionId: string, action: ConnectionAction,
  options: LifecycleOptions = {}): Promise<ConnectionPlan> {
  return operation(auth, changeId, "PROVIDER.CONNECTION.PLAN", "providers.manage", async (tx) => {
    const target = await readTarget(tx, auth, providerConnectionId, false);
    const to = assertAllowed(target, action);
    const evidence = firstActivation(target, to) ? await activationEvidence(tx, auth, target, clock(options)) : undefined;
    const open = await openSessions(tx, auth, target.id);
    const sessionsToRevoke = to === "QUARANTINED" ? open : 0;
    const planDigest = connectionPlanDigest(auth, target, action, evidence);
    return {
      value: { providerConnectionId: target.id, action, from: target.status, to, openSessions: open, sessionsToRevoke, planDigest,
        ...(evidence ? { activationEvidence: evidence } : {}) },
      metadata: metadataOf(target, action, to, { openSessions: open, sessionsToRevoke, planDigest, ...(evidence ?? {}) }),
    };
  });
}

/**
 * Applies a planned action. The plan digest must match the current state. A quarantine revokes every open
 * session opened through the connection, in the same transaction; DISABLE keeps them until they expire (R5).
 * Never deletes a connection, an account, a Subject or an access.
 */
export function applyConnectionTransition(auth: AuthContext, changeId: string, providerConnectionId: string, action: ConnectionAction, planDigest: string,
  options: LifecycleOptions = {}): Promise<ConnectionTransition> {
  return operation(auth, changeId, `PROVIDER.CONNECTION.${action}`, "providers.manage", async (tx) => {
    if (!(action in CONNECTION_ACTIONS)) throw new CanonicalAdminError("INVALID_CONNECTION_ACTION", 400);
    const target = await readTarget(tx, auth, providerConnectionId, true);
    const to = assertAllowed(target, action);
    // First activation: the evidence is read again here, under the governance lock and the row lock, at apply time (so
    // it may also have become too old since the plan), and it is part of the digest.
    const evidence = firstActivation(target, to) ? await activationEvidence(tx, auth, target, clock(options)) : undefined;
    if (planDigest !== connectionPlanDigest(auth, target, action, evidence)) throw new CanonicalAdminError("CONNECTION_PLAN_STALE", 409);
    const open = await openSessions(tx, auth, target.id);
    await tx.$executeRaw`UPDATE "ProviderConnection" SET "status" = ${to}::"ProviderConnectionStatus"
      WHERE "organizationId" = ${auth.organizationId} AND "id" = ${target.id}`;
    const revokedSessions = to === "QUARANTINED" ? await revokeProviderConnectionSessions(tx, auth.organizationId, target.id) : 0;
    // Deferred checks now (an incomplete quarantine fails here): Prisma 5 does not report a failed COMMIT.
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    const [changed] = await tx.$queryRaw<Array<{ statusChangedAt: Date }>>`
      SELECT "statusChangedAt" FROM "ProviderConnection" WHERE "organizationId" = ${auth.organizationId} AND "id" = ${target.id}`;
    return {
      value: { providerConnectionId: target.id, action, from: target.status, to, openSessions: open, revokedSessions, statusChangedAt: changed.statusChangedAt.toISOString(),
        ...(evidence ? { activationEvidence: evidence } : {}) },
      metadata: metadataOf(target, action, to, { openSessions: open, revokedSessions, planDigest, ...(evidence ?? {}) }),
    };
  });
}
