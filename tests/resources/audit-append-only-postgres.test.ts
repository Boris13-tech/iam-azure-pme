import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";

// T0, audit integrity, on PostgreSQL: the journal and the sign-in evidence are append-only for the
// application (app_user) and for every ordinary statement of the owner role the LUXIA operator uses.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
let owner: PrismaClient;
type Scope = { organizationId: string; tenantId: string };
let scope: Scope;
let subjectId: string, accountId: string, connectionId: string;

const event = (data: Partial<Prisma.CanonicalAdminAuditEventUncheckedCreateInput> = {}) => ({
  ...scope, actorSubjectId: subjectId, operation: "SESSION.SIGN_OUT", result: "SUCCESS" as const, changeId: `t0:${randomUUID()}`, metadata: {}, ...data,
});
const evidence = () => ({
  id: randomUUID(), ...scope, subjectId, identityAccountId: accountId, providerConnectionId: connectionId,
  method: "PASSKEY" as const, outcome: "VERIFIED" as const, assuranceLevel: "SUBSTANTIAL" as const, assuranceProfile: "local-passkey",
  assuranceProfileVersion: 1, phishingResistant: true, hardwareBound: false, userVerification: "VERIFIED" as const,
  source: "LOCAL_VERIFIER" as const, sourceRef: "t0", verifierPolicyVersion: 1, operationId: randomUUID(),
  reasonCode: "LOCAL_PASSKEY_ASSERTION_VERIFIED", occurredAt: new Date(),
});
const ROLLBACK = new Error("rollback");
/** Runs statements as the owner in a transaction that is always rolled back, whatever happens. */
async function ownerAttempt(work: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let outcome: unknown;
  await owner.$transaction(async (tx) => { outcome = await work(tx).then(() => "ACCEPTED", (error: Error) => error.message); throw ROLLBACK; })
    .catch((error) => { if (error !== ROLLBACK) throw error; });
  return outcome as string;
}

describe.runIf(enabled)("T0 append-only journal and sign-in evidence (PostgreSQL)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    scope = { organizationId: randomUUID(), tenantId: randomUUID() };
    await owner.organization.create({ data: { id: scope.organizationId, name: "T0", slug: `t0-${scope.organizationId.slice(0, 8)}` } });
    await owner.tenant.create({ data: { id: scope.tenantId, organizationId: scope.organizationId, name: "Production" } });
    connectionId = (await owner.providerConnection.create({ data: { organizationId: scope.organizationId, providerType: "LUXIA_LOCAL", externalScopeId: `t0-${randomUUID()}`, name: "Local" } })).id;
    subjectId = (await owner.subject.create({ data: { ...scope, type: "HUMAN", name: "T0 person", lifecycleState: "ACTIVE" } })).id;
    accountId = (await owner.identityAccount.create({ data: { ...scope, subjectId, providerConnectionId: connectionId, externalObjectId: randomUUID() } })).id;
  });
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("the application still inserts journal events and sign-in evidence, and reads them", async () => {
    const written = await withTenantDb(scope, async (tx) => ({
      event: await tx.canonicalAdminAuditEvent.create({ data: event() }),
      evidence: await tx.authenticationEvidence.create({ data: evidence() }),
    }));
    expect(await withTenantDb(scope, (tx) => tx.canonicalAdminAuditEvent.findUnique({ where: { id: written.event.id } }))).not.toBeNull();
    expect(await withTenantDb(scope, (tx) => tx.authenticationEvidence.findUnique({ where: { id: written.evidence.id } }))).not.toBeNull();
  });

  it("the application can neither update nor delete them: the right is gone, and the guard stands behind it", async () => {
    const row = await withTenantDb(scope, (tx) => tx.canonicalAdminAuditEvent.create({ data: event() }));
    const proof = await withTenantDb(scope, (tx) => tx.authenticationEvidence.create({ data: evidence() }));
    const attempts: Array<(tx: Prisma.TransactionClient) => Promise<unknown>> = [
      async (tx: Prisma.TransactionClient) => tx.canonicalAdminAuditEvent.update({ where: { id: row.id }, data: { result: "DENIED" } }),
      async (tx: Prisma.TransactionClient) => tx.canonicalAdminAuditEvent.delete({ where: { id: row.id } }),
      async (tx: Prisma.TransactionClient) => tx.authenticationEvidence.update({ where: { id: proof.id }, data: { outcome: "REJECTED" } }),
      async (tx: Prisma.TransactionClient) => tx.authenticationEvidence.delete({ where: { id: proof.id } }),
      async (tx: Prisma.TransactionClient) => tx.$executeRaw`TRUNCATE "CanonicalAdminAuditEvent"`,
    ];
    for (const attempt of attempts) await expect(withTenantDb(scope, attempt)).rejects.toThrow(/permission denied|42501/);
    const grants = await owner.$queryRaw<Array<{ table_name: string; privileges: string }>>`
      SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges FROM information_schema.role_table_grants
      WHERE grantee = 'app_user' AND table_name IN ('CanonicalAdminAuditEvent', 'AuthenticationEvidence') GROUP BY table_name ORDER BY table_name`;
    expect(grants).toEqual([{ table_name: "AuthenticationEvidence", privileges: "INSERT,SELECT" }, { table_name: "CanonicalAdminAuditEvent", privileges: "INSERT,SELECT" }]);
    expect(await owner.canonicalAdminAuditEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ result: "SUCCESS" });
  });

  it("the owner role (the operator's) cannot erase or rewrite the trail by an ordinary statement", async () => {
    const row = await owner.canonicalAdminAuditEvent.create({ data: event({ operation: "BREAK_GLASS.SESSION.REVOKE" }) });
    const proof = await owner.authenticationEvidence.create({ data: evidence() });
    for (const attempt of <Array<(tx: Prisma.TransactionClient) => Promise<unknown>>>[
      async (tx: Prisma.TransactionClient) => tx.canonicalAdminAuditEvent.update({ where: { id: row.id }, data: { metadata: { rewritten: true } } }),
      async (tx: Prisma.TransactionClient) => tx.canonicalAdminAuditEvent.deleteMany({ where: { id: row.id } }),
      async (tx: Prisma.TransactionClient) => tx.$executeRaw`TRUNCATE "CanonicalAdminAuditEvent"`,
      async (tx: Prisma.TransactionClient) => tx.authenticationEvidence.update({ where: { id: proof.id }, data: { reasonCode: "REWRITTEN" } }),
      async (tx: Prisma.TransactionClient) => tx.authenticationEvidence.deleteMany({ where: { id: proof.id } }),
      async (tx: Prisma.TransactionClient) => tx.$executeRaw`TRUNCATE "AuthenticationEvidence"`,
    ]) expect(await ownerAttempt(attempt)).toMatch(/AUDIT_APPEND_ONLY/);
    expect(await owner.canonicalAdminAuditEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ metadata: {} });
    expect(await owner.authenticationEvidence.findUniqueOrThrow({ where: { id: proof.id } })).toMatchObject({ reasonCode: "LOCAL_PASSKEY_ASSERTION_VERIFIED" });
  });

  it("schema migrations stay possible; a data fix needs the guard disabled explicitly, in a reviewed migration", async () => {
    expect(await ownerAttempt((tx) => tx.$executeRaw`ALTER TABLE "CanonicalAdminAuditEvent" ADD COLUMN "t0Probe" TEXT`)).toBe("ACCEPTED");
    const row = await owner.canonicalAdminAuditEvent.create({ data: event() });
    expect(await ownerAttempt(async (tx) => {
      await tx.$executeRaw`ALTER TABLE "CanonicalAdminAuditEvent" DISABLE TRIGGER audit_append_only`;
      await tx.canonicalAdminAuditEvent.update({ where: { id: row.id }, data: { result: "DENIED" } });
    })).toBe("ACCEPTED");
    // Both attempts were rolled back: no column, the row and the guard are unchanged.
    expect(await owner.canonicalAdminAuditEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ result: "SUCCESS" });
    const triggers = await owner.$queryRaw<Array<{ tgname: string; tgenabled: string }>>`
      SELECT tgname, tgenabled::text FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('"CanonicalAdminAuditEvent"'::regclass, '"AuthenticationEvidence"'::regclass) ORDER BY tgname`;
    expect(triggers).toEqual([
      { tgname: "audit_append_only", tgenabled: "O" }, { tgname: "audit_append_only_truncate", tgenabled: "O" },
      { tgname: "evidence_append_only", tgenabled: "O" }, { tgname: "evidence_append_only_truncate", tgenabled: "O" },
      { tgname: "resource_onboarding_evidence_immutable", tgenabled: "O" },
    ]);
  });
});
