// D8.1 (Beta scope, section 4.2): the retention status gives, per mechanism, the eligible records, those past their
// period plus 3 days (the backlog alert) and the age of the oldest; each call and each R4 or R6 run leaves a record in
// the owner-only RetentionRun table. Real roles on PostgreSQL: the runtime role calls it, and never reads the records.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { rollbacksAfter } from "../helpers/migration-rollbacks";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const suffix = randomUUID().slice(0, 8);
const DAY = 86_400_000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let owner: PrismaClient;

type Mechanism = { eligible: number; overdue: number; oldestHours: number; held?: number };
type Status = { R3: Mechanism; R4: Mechanism; R6: Mechanism };
const status = async (db: PrismaClient = rawPrisma) =>
  (await db.$queryRawUnsafe<Array<{ status: Status }>>("SELECT luxia_retention_status() AS status"))[0].status;
const records = async (mechanism: string) =>
  (await owner.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "RetentionRun" WHERE "counts"->>'mechanism' = $1`, mechanism))[0].n;
const settle = (promise: Promise<unknown>) => promise.then(() => "ACCEPTED", (error: unknown) => String(error instanceof Error ? error.message : error));

describe.runIf(enabled)("D8.1: retention status and run records (PostgreSQL)", () => {
  const scope = { organizationId: randomUUID(), tenantId: randomUUID() };
  let accountId = "";
  const challenge = (expiredDaysAgo: number) => owner.localAuthChallenge.create({ data: { ...scope, identityAccountId: accountId, purpose: "AUTHENTICATION",
    challengeHash: sha(randomUUID()), expiresAt: new Date(Date.now() - expiredDaysAgo * DAY) } });
  const retired = async (daysAgo: number, pseudonymized = false) => {
    const subject = await owner.subject.create({ data: { ...scope, type: "HUMAN", name: `Leaver ${randomUUID().slice(0, 6)}`, lifecycleState: "RETIRED" } });
    const name = pseudonymized ? `Ancien membre ${sha(subject.id).slice(0, 8)}` : subject.name;
    // The lifecycle date is the database's since #148: aged here as a superuser would, triggers off for this statement.
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRawUnsafe(`UPDATE "Subject" SET "lifecycleChangedAt" = (now() AT TIME ZONE 'UTC') - $2::float8 * interval '1 day', "name" = $3 WHERE "id" = $1`,
        subject.id, daysAgo, name);
    });
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    await owner.organization.create({ data: { id: scope.organizationId, name: "D8.1 fixture", slug: `d81-${suffix}` } });
    await owner.tenant.create({ data: { id: scope.tenantId, organizationId: scope.organizationId, name: "Production" } });
    const local = await owner.providerConnection.create({ data: { organizationId: scope.organizationId, providerType: "LUXIA_LOCAL", externalScopeId: `local-${suffix}`, name: "Local" } });
    const subject = await owner.subject.create({ data: { ...scope, type: "HUMAN", name: "Holder", lifecycleState: "ACTIVE" } });
    const account = await owner.identityAccount.create({ data: { ...scope, subjectId: subject.id, providerConnectionId: local.id, externalObjectId: randomUUID() } });
    accountId = account.id;
    await owner.localIdentity.create({ data: { ...scope, identityAccountId: accountId, principalName: `d81-${suffix}` } });
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("the runtime role gets counts and ages for R3, R4 and R6, and the call is recorded", async () => {
    const before = await records("status");
    const now = await status();
    for (const mechanism of ["R3", "R4", "R6"] as const) {
      // R4 and R6 also report what holds keep (D8.2); R3 has no hold.
      expect(Object.keys(now[mechanism]).sort(), mechanism).toEqual(mechanism === "R3" ? ["eligible", "oldestHours", "overdue"] : ["eligible", "held", "oldestHours", "overdue"]);
      for (const value of Object.values(now[mechanism])) expect(Number.isInteger(value) && value >= 0, mechanism).toBe(true);
    }
    expect(await records("status")).toBe(before + 1);
  }, 60_000);

  it("R3: eligible after 7 days, overdue after 10, and the age of the oldest in hours", async () => {
    const before = await status();
    await challenge(8);      // eligible, not overdue
    await challenge(12);     // eligible and overdue
    await challenge(3650);   // the oldest of the database
    await challenge(6);      // not eligible
    const after = await status();
    expect(after.R3.eligible - before.R3.eligible).toBe(3);
    expect(after.R3.overdue - before.R3.overdue).toBe(2);
    expect(after.R3.oldestHours).toBeGreaterThanOrEqual(3650 * 24);
  }, 60_000);

  it("R6: a person retired for more than 30 days, not yet pseudonymized, is eligible; overdue after 33 days", async () => {
    const before = await status();
    await retired(31);         // eligible, not overdue
    await retired(40);         // eligible and overdue
    await retired(40, true);   // already pseudonymized: not counted
    await retired(10);         // too recent
    const after = await status();
    expect(after.R6.eligible - before.R6.eligible).toBe(2);
    expect(after.R6.overdue - before.R6.overdue).toBe(1);
    expect(after.R6.oldestHours).toBeGreaterThanOrEqual(40 * 24 - 1);
  }, 60_000);

  it("R4 and R6 runs leave a run record each, counts only; the runtime role cannot read the records", async () => {
    const r4 = await records("R4"), r6 = await records("R6");
    await rawPrisma.$queryRawUnsafe("SELECT luxia_retention_purge_invitations(10, false)");
    await rawPrisma.$queryRawUnsafe("SELECT luxia_retention_pseudonymize_retired(10, false)");
    expect(await records("R4")).toBe(r4 + 1);
    expect(await records("R6")).toBe(r6 + 1);
    const [last] = await owner.$queryRawUnsafe<Array<{ counts: Record<string, unknown> }>>(
      `SELECT "counts" FROM "RetentionRun" WHERE "counts"->>'mechanism' = 'R6' ORDER BY "id" DESC LIMIT 1`);
    expect(Object.keys(last.counts).sort()).toEqual(["displayNames", "held", "mechanism", "principalNames", "subjects"]);
    expect(await settle(rawPrisma.$queryRawUnsafe(`SELECT count(*) FROM "RetentionRun"`))).toMatch(/permission denied/);
  }, 60_000);

  // Codex, review of #138: the rollback must leave Prisma's history consistent, so the normal deploy path restores it.
  it("drill with Prisma's real history: rollback removes the function and its history line; migrate deploy brings both back", () => {
    const psql = (url: string, args: string[]) => {
      const target = new URL(url); target.search = "";
      const result = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`psql failed: ${result.stderr ?? result.error}`);
      return result.stdout.replace(/\r/g, "").trim();
    };
    const prisma = createRequire(import.meta.url).resolve("prisma/build/index.js");
    const deploy = (url: string) => {
      const result = spawnSync(process.execPath, [prisma, "migrate", "deploy"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } });
      if (result.status !== 0) throw new Error(`migrate deploy failed: ${result.stdout}${result.stderr}`);
    };
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_d81_${suffix}`;
    psql(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const state = () => psql(url, ["-c", `SELECT to_regprocedure('luxia_retention_status()') IS NOT NULL`,
      "-c", `SELECT count(*) FROM "_prisma_migrations" WHERE "migration_name" = '20261112100000_retention_status' AND "finished_at" IS NOT NULL`]).split("\n");
    try {
      deploy(url);
      expect(state()).toEqual(["t", "1"]);
      expect(psql(url, ["-c", `SELECT (luxia_retention_status() ? 'R3')::text`])).toBe("true");
      // Only the last applied migration rolls back: every migration newer than the status comes back off first,
      // newest first, which keeps this drill correct as later migrations are added.
      for (const script of rollbacksAfter("20261112100000_retention_status")) psql(url, ["-1", "-f", script]);
      psql(url, ["-1", "-f", "docs/operations/RETENTION-STATUS-ROLLBACK.sql"]);
      expect(state()).toEqual(["f", "0"]);
      deploy(url);
      expect(state()).toEqual(["t", "1"]);
      expect(psql(url, ["-c", `SELECT (luxia_retention_status() ? 'R6')::text`])).toBe("true");
    } finally {
      spawnSync("psql", ["-X", "-q", (() => { const t = new URL(admin); t.search = ""; return t.toString(); })(), "-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`], { encoding: "utf8" });
    }
  }, 240_000);
});
