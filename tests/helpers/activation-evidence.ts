import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

// Test fixtures only (the database owner, never the runtime). Since F4 S5 (migration 20261016110000) the database
// itself refuses TESTING -> ACTIVE without valid activation evidence. Suites that need an ACTIVE generic connection as a
// precondition record that evidence here, exactly as the real flows would (a passing test and a passing proof on the
// current configuration, the proof made with the live secret version), then activate under the governance lock.
type Scope = Readonly<{ organizationId: string; tenantId: string }>;
const lockSql = (scope: Scope) => `SELECT pg_advisory_xact_lock(hashtextextended('resource-governance:${scope.organizationId}:${scope.tenantId}', 0))::text`;

/** Records a passing DISCOVERY run and a passing PROOF run on the connection's current configuration hash. */
export async function seedActivationEvidence(owner: PrismaClient, scope: Scope, connectionId: string, actorSubjectId = "test-fixture"): Promise<void> {
  await owner.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(lockSql(scope));
    const live = await tx.providerSecretReference.findFirst({ where: { providerConnectionId: connectionId, purpose: "OIDC_CLIENT", revokedAt: null } });
    const secret = live ?? await tx.providerSecretReference.create({ data: { organizationId: scope.organizationId, providerConnectionId: connectionId,
      purpose: "OIDC_CLIENT", store: "azure-key-vault", locator: "akv://luxia-test-vault/fixture", activeVersion: randomBytes(16).toString("hex") } });
    const { configurationHash } = await tx.providerOidcConfiguration.findUniqueOrThrow({ where: { providerConnectionId: connectionId } });
    for (const kind of ["DISCOVERY", "PROOF"] as const) {
      await tx.providerTestRun.create({ data: { organizationId: scope.organizationId, providerConnectionId: connectionId, kind, outcome: "PASSED",
        reasonCode: `${kind}_PASSED`, configurationHash, actorSubjectId, metadata: kind === "PROOF" ? { secretVersion: secret.activeVersion } : {} } });
    }
  });
}

/** Moves a configured generic connection to ACTIVE with fresh evidence (DRAFT goes through TESTING first). */
export async function activateWithEvidence(owner: PrismaClient, scope: Scope, connectionId: string): Promise<void> {
  await seedActivationEvidence(owner, scope, connectionId);
  await owner.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(lockSql(scope));
    await tx.$executeRawUnsafe(`UPDATE "ProviderConnection" SET status = 'TESTING' WHERE id = '${connectionId}' AND status = 'DRAFT'`);
    await tx.$executeRawUnsafe(`UPDATE "ProviderConnection" SET status = 'ACTIVE' WHERE id = '${connectionId}'`);
  });
}

/**
 * Inserts a test run with a chosen age, for freshness tests only: the database stamps every run with its own clock, so
 * an old run can only be made by bypassing the stamp trigger, for this one transaction (session_replication_role).
 */
export async function insertAgedRun(owner: PrismaClient, run: { organizationId: string; providerConnectionId: string; kind: "DISCOVERY" | "PROOF";
  outcome: "PASSED" | "FAILED"; configurationHash: string; secretVersion?: string; minutesAgo: number }): Promise<string> {
  const id = randomUUID();
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.$executeRaw`INSERT INTO "ProviderTestRun" ("id", "organizationId", "providerConnectionId", "kind", "outcome", "reasonCode", "configurationHash", "metadata", "actorSubjectId", "occurredAt")
      VALUES (${id}, ${run.organizationId}, ${run.providerConnectionId}, ${run.kind}, ${run.outcome}, ${`${run.kind}_${run.outcome}`}, ${run.configurationHash},
        ${JSON.stringify(run.secretVersion ? { secretVersion: run.secretVersion } : {})}::jsonb, 'test-fixture',
        (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(mins => ${run.minutesAgo}::int))`;
  });
  return id;
}
