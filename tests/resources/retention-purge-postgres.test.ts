// R3 (docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md): the daily job deletes sign-in challenges
// and Microsoft sign-in transactions expired for more than 7 days, in bounded batches, through one
// definer function the runtime may call; it records counts only. Real roles on PostgreSQL.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { purgeExpiredTransactions } from "../../lib/retention/purge";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261023130000_retention_purge_transactions";
const ROLLBACK = "docs/operations/RETENTION-PURGE-TRANSACTIONS-ROLLBACK.sql";
const suffix = randomUUID().slice(0, 8);
const DAY = 86_400_000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let owner: PrismaClient;

function psql(url: string, args: string[]) {
  const target = new URL(url); target.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8" });
}
function psqlOk(url: string, args: string[]) {
  const result = psql(url, args);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout;
}
const settle = (promise: Promise<unknown>) => promise.then(() => "ACCEPTED", (error: unknown) => String(error instanceof Error ? error.message : error));

describe.runIf(enabled)("R3: purge of expired challenges and transactions (PostgreSQL)", () => {
  const scope = { organizationId: randomUUID(), tenantId: randomUUID() };
  let accountId = "";
  const challenge = (expiredDaysAgo: number) => owner.localAuthChallenge.create({ data: { ...scope, identityAccountId: accountId, purpose: "AUTHENTICATION",
    challengeHash: sha(randomUUID()), expiresAt: new Date(Date.now() - expiredDaysAgo * DAY) } }).then((row) => row.id);
  const transaction = (expiredDaysAgo: number) => owner.authTransaction.create({ data: { id: randomUUID(), stateHash: sha(randomUUID()), nonce: "n", codeVerifier: "v",
    expectedOrganizationId: scope.organizationId, expectedTenantId: scope.tenantId, expectedProviderConnectionId: "p",
    expiresAt: new Date(Date.now() - expiredDaysAgo * DAY) } }).then((row) => row.id);
  const exists = async (ids: { challenges: string[]; transactions: string[] }) => ({
    challenges: (await owner.localAuthChallenge.findMany({ where: { id: { in: ids.challenges } }, select: { id: true } })).map((r) => r.id).sort(),
    transactions: (await owner.authTransaction.findMany({ where: { id: { in: ids.transactions } }, select: { id: true } })).map((r) => r.id).sort(),
  });

  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    await owner.organization.create({ data: { id: scope.organizationId, name: "R3 fixture", slug: `r3-${suffix}` } });
    await owner.tenant.create({ data: { id: scope.tenantId, organizationId: scope.organizationId, name: "Production" } });
    const local = await owner.providerConnection.create({ data: { organizationId: scope.organizationId, providerType: "LUXIA_LOCAL", externalScopeId: `local-${suffix}`, name: "Local" } });
    const subject = await owner.subject.create({ data: { ...scope, type: "HUMAN", name: "Holder", lifecycleState: "ACTIVE" } });
    const account = await owner.identityAccount.create({ data: { ...scope, subjectId: subject.id, providerConnectionId: local.id, externalObjectId: randomUUID() } });
    accountId = account.id;
    await owner.localIdentity.create({ data: { ...scope, identityAccountId: accountId, principalName: `r3-${suffix}` } });
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("the runtime role runs it: dry run first, then only rows expired for more than 7 days go", async () => {
    const old = { challenges: [await challenge(8), await challenge(30)], transactions: [await transaction(8), await transaction(30)] };
    const kept = { challenges: [await challenge(6), await challenge(-1)], transactions: [await transaction(6), await transaction(-1)] };
    const all = { challenges: [...old.challenges, ...kept.challenges], transactions: [...old.transactions, ...kept.transactions] };

    const dry = await purgeExpiredTransactions(false, rawPrisma);
    expect(dry.enforced).toBe(false);
    expect(dry.localAuthChallenges).toBeGreaterThanOrEqual(2);
    expect(dry.authTransactions).toBeGreaterThanOrEqual(2);
    expect(await exists(all)).toEqual({ challenges: [...all.challenges].sort(), transactions: [...all.transactions].sort() });

    const run = await purgeExpiredTransactions(true, rawPrisma);
    expect(run.enforced).toBe(true);
    expect(run.localAuthChallenges).toBeGreaterThanOrEqual(2);
    expect(await exists(all)).toEqual({ challenges: [...kept.challenges].sort(), transactions: [...kept.transactions].sort() });
    expect((await purgeExpiredTransactions(true, rawPrisma)).localAuthChallenges).toBe(0);
  });

  it("each call is bounded by its batch, and arguments out of range are refused", async () => {
    const old = { challenges: [await challenge(9), await challenge(9)], transactions: [await transaction(9), await transaction(9)] };
    const call = (batch: number, enforce: boolean | null) =>
      rawPrisma.$queryRawUnsafe<Array<{ counts: Record<string, number> }>>(`SELECT luxia_retention_purge_transactions(${batch}, ${enforce}) AS counts`).then((rows) => rows[0].counts);
    expect(await call(1, true)).toMatchObject({ localAuthChallenges: 1, authTransactions: 1 });
    const left = await exists(old);
    expect(left.challenges).toHaveLength(1);
    expect(left.transactions).toHaveLength(1);
    expect(await call(5000, true)).toMatchObject({ localAuthChallenges: 1, authTransactions: 1 });
    for (const [batch, enforce] of [[0, true], [5001, true], [10, null]] as const)
      expect(await settle(call(batch, enforce))).toMatch(/RETENTION_ARGUMENT_OUT_OF_RANGE/);
  });

  it("records counts only, in a table the runtime role cannot read or write", async () => {
    const runs = await owner.retentionRun.findMany({ orderBy: { id: "desc" }, take: 3 });
    expect(runs.length).toBe(3);
    for (const run of runs) expect(Object.keys(run.counts as object).sort()).toEqual(["authTransactions", "localAuthChallenges", "retentionRuns"]);
    expect(await settle(rawPrisma.$queryRawUnsafe(`SELECT count(*) FROM "RetentionRun"`))).toMatch(/permission denied/);
    expect(await settle(rawPrisma.$executeRawUnsafe(`INSERT INTO "RetentionRun" ("enforced", "counts") VALUES (true, '{}')`))).toMatch(/permission denied/);
  });

  it("drill: the migration applies on a scratch database, the rollback restores the catalog, and it applies again", () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_r3_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const catalog = () => psqlOk(url, ["-c", `SELECT string_agg(c.relname::text || ':' || c.relkind::text, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`,
      "-c", `SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`]).replace(/\r/g, "");
    try {
      const prior = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
      for (const dir of prior) psqlOk(url, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      const before = catalog();
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(psqlOk(url, ["-c", `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'RetentionRun'`]).trim()).toBe("t");
      expect(psqlOk(url, ["-c", `SELECT luxia_retention_purge_transactions(10, true)->>'enforced'`]).trim()).toBe("true");
      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(catalog()).toBe(before);
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 240_000);
});
