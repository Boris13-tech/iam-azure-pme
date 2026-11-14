// Issue #148, dependency of R6 enforcing: PostgreSQL owns the lifecycle dates of "Subject". The runtime role may
// UPDATE every column, so R6's 30-day window must not rest on a date a caller chooses. On real roles: the date is
// stamped by the database, a backdating attempt is refused, RETIRED is terminal, and the legitimate flows still work.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { SUBJECT_LIFECYCLE_STATES, canTransitionSubject } from "../../lib/identity/semantics";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261114090000_subject_lifecycle_guard";
const ROLLBACK = "docs/operations/SUBJECT-LIFECYCLE-GUARD-ROLLBACK.sql";
const suffix = randomUUID().slice(0, 8);
const DAY = 86_400_000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let owner: PrismaClient;
const scope = { organizationId: randomUUID(), tenantId: randomUUID() };

const codeOf = (promise: Promise<unknown>) => promise.then(() => "OK", (error: { message?: string }) => /[A-Z][A-Z0-9_]{5,}/.exec(String(error.message))?.[0] ?? String(error.message));
type Row = { lifecycleState: string; lifecycleVersion: number; lifecycleChangedAt: Date; name: string; updatedAt: Date };
const read = async (id: string) => (await owner.subject.findUniqueOrThrow({ where: { id }, select: { lifecycleState: true, lifecycleVersion: true, lifecycleChangedAt: true, name: true, updatedAt: true } })) as Row;
const ageSeconds = (at: Date) => (Date.now() - at.getTime()) / 1000;

function psql(url: string, args: string[]) {
  const target = new URL(url); target.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8" });
}
function psqlOk(url: string, args: string[]) {
  const result = psql(url, args);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr ?? result.error}`);
  return result.stdout.replace(/\r/g, "").trim();
}

describe.runIf(enabled)("#148: the database owns the lifecycle dates of Subject (PostgreSQL)", () => {
  /** A subject in a given state, created through the application's own path. */
  const subject = (state: string = "ACTIVE") =>
    owner.subject.create({ data: { ...scope, type: "HUMAN", name: `Person ${randomUUID().slice(0, 6)}`, lifecycleState: state as never } });
  /** The same statement the runtime role can run: it holds UPDATE on every column of Subject. */
  const asRuntime = (sql: string, ...values: unknown[]) => rawPrisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.organization_id', ${scope.organizationId}, true), set_config('app.tenant_id', ${scope.tenantId}, true)`;
    return tx.$executeRawUnsafe(sql, ...values);
  });

  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    await owner.organization.create({ data: { id: scope.organizationId, name: "Lifecycle guard", slug: `lifecycle-${suffix}` } });
    await owner.tenant.create({ data: { id: scope.tenantId, organizationId: scope.organizationId, name: "Production" } });
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("INSERT: the date is the database's and the version is 1, whatever the caller sent", async () => {
    const backdated = new Date(Date.now() - 400 * DAY);
    const created = await owner.subject.create({ data: { ...scope, type: "HUMAN", name: "Inserted", lifecycleState: "RETIRED",
      lifecycleChangedAt: backdated, lifecycleVersion: 99 } });
    const row = await read(created.id);
    expect(ageSeconds(row.lifecycleChangedAt)).toBeLessThan(120);
    expect(row.lifecycleVersion).toBe(1);
    // The same through raw SQL as the runtime role: no path can insert a backdated lifecycle.
    const id = randomUUID();
    expect(await codeOf(asRuntime(`INSERT INTO "Subject" ("id", "organizationId", "tenantId", "type", "name", "lifecycleState", "lifecycleVersion", "lifecycleChangedAt", "updatedAt")
      VALUES ($1, $2, $3, 'HUMAN', 'Raw insert', 'RETIRED', 99, $4, now())`, id, scope.organizationId, scope.tenantId, backdated))).toBe("OK");
    const raw = await read(id);
    expect(ageSeconds(raw.lifecycleChangedAt)).toBeLessThan(120);
    expect(raw.lifecycleVersion).toBe(1);
  }, 60_000);

  it("the backdating of #148 is refused: RETIRED with a date 31 days ago, in one statement, as the runtime role", async () => {
    const person = await subject("ACTIVE");
    // The exact statement of the issue: it used to make the person eligible for R6 at once.
    expect(await codeOf(asRuntime(`UPDATE "Subject" SET "lifecycleState" = 'RETIRED', "lifecycleChangedAt" = (now() AT TIME ZONE 'UTC') - interval '31 days' WHERE "id" = $1`, person.id))).toBe("OK");
    const row = await read(person.id);
    expect(row.lifecycleState).toBe("RETIRED");
    expect(ageSeconds(row.lifecycleChangedAt)).toBeLessThan(120); // stamped now: the 30-day window starts here
    expect(row.lifecycleVersion).toBe(2);
    // And R6 does not see this person: its cutoff is 30 days.
    const [{ counts }] = await owner.$queryRawUnsafe<Array<{ counts: { subjects: number } }>>(`SELECT luxia_retention_pseudonymize_retired(5000, false) AS counts`);
    expect(counts.subjects).toBe(0);
  }, 60_000);

  // Codex, review of #194: now() is the transaction's start time, so a caller holding a transaction open could have a
  // fresh retirement stamped with an old time and become eligible for R6 at once. The stamp is the statement's time.
  it("the age of the caller's transaction does not age the transition: the stamp is the statement's time", async () => {
    const person = await subject("ACTIVE");
    const [times] = await rawPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${scope.organizationId}, true), set_config('app.tenant_id', ${scope.tenantId}, true)`;
      // The transaction's clock is fixed here; two seconds of it pass before the transition, as a long-lived caller's would.
      await tx.$executeRawUnsafe(`SELECT pg_sleep(2)`); // pg_sleep returns void: $executeRaw, not $queryRaw
      await tx.$executeRawUnsafe(`UPDATE "Subject" SET "lifecycleState" = 'RETIRED' WHERE "id" = $1`, person.id);
      return tx.$queryRawUnsafe<Array<{ afterTransactionStart: number; beforeStatementTime: number }>>(`
        SELECT extract(epoch FROM (s."lifecycleChangedAt" - (now() AT TIME ZONE 'UTC')))::float8 AS "afterTransactionStart",
               extract(epoch FROM ((clock_timestamp() AT TIME ZONE 'UTC') - s."lifecycleChangedAt"))::float8 AS "beforeStatementTime"
        FROM "Subject" s WHERE s."id" = $1`, person.id);
    }, { timeout: 30_000 });
    // Stamped at least the slept time after the transaction began, and no later than the statement that read it back.
    expect(times.afterTransactionStart).toBeGreaterThan(1.5);
    expect(times.beforeStatementTime).toBeGreaterThanOrEqual(0);
    expect(times.beforeStatementTime).toBeLessThan(5);
    // And the person is not eligible for R6, whose cutoff is 30 days.
    const [{ counts }] = await owner.$queryRawUnsafe<Array<{ counts: { subjects: number } }>>(`SELECT luxia_retention_pseudonymize_retired(5000, false) AS counts`);
    expect(counts.subjects).toBe(0);
  }, 120_000);

  it("a change of the date without a state change is refused, for the runtime role and for the owner", async () => {
    const person = await subject("RETIRED");
    const before = await read(person.id);
    for (const sql of [`UPDATE "Subject" SET "lifecycleChangedAt" = (now() AT TIME ZONE 'UTC') - interval '31 days' WHERE "id" = $1`,
      `UPDATE "Subject" SET "lifecycleChangedAt" = (now() AT TIME ZONE 'UTC') + interval '5 days' WHERE "id" = $1`]) {
      expect(await codeOf(asRuntime(sql, person.id)), sql).toBe("SUBJECT_LIFECYCLE_DATE_IMMUTABLE");
      expect(await codeOf(owner.$executeRawUnsafe(sql, person.id)), `owner: ${sql}`).toBe("SUBJECT_LIFECYCLE_DATE_IMMUTABLE");
    }
    expect(await codeOf(asRuntime(`UPDATE "Subject" SET "lifecycleVersion" = 99 WHERE "id" = $1`, person.id))).toBe("SUBJECT_LIFECYCLE_VERSION_IMMUTABLE");
    // Setting the same state again is not a change: refused all the same when it carries a new date.
    expect(await codeOf(asRuntime(`UPDATE "Subject" SET "lifecycleState" = 'RETIRED', "lifecycleChangedAt" = (now() AT TIME ZONE 'UTC') - interval '31 days' WHERE "id" = $1`, person.id)))
      .toBe("SUBJECT_LIFECYCLE_DATE_IMMUTABLE");
    expect(await read(person.id)).toEqual(before);
  }, 60_000);

  it("every other column still updates, R6's own pseudonymization included", async () => {
    const person = await subject("RETIRED");
    const before = await read(person.id);
    expect(await codeOf(asRuntime(`UPDATE "Subject" SET "name" = 'Renamed' WHERE "id" = $1`, person.id))).toBe("OK");
    // R6 writes exactly this, with the lifecycle triple untouched.
    expect(await codeOf(owner.$executeRawUnsafe(`UPDATE "Subject" SET "name" = $2 WHERE "id" = $1`, person.id, `Ancien membre ${sha(person.id).slice(0, 8)}`))).toBe("OK");
    const after = await read(person.id);
    expect(after.name).toBe(`Ancien membre ${sha(person.id).slice(0, 8)}`);
    expect(after.lifecycleChangedAt).toEqual(before.lifecycleChangedAt);
    expect(after.lifecycleVersion).toBe(before.lifecycleVersion);
  }, 60_000);

  it("the database enforces the application's transition table, RETIRED terminal, and stamps each allowed change", async () => {
    for (const from of SUBJECT_LIFECYCLE_STATES) {
      for (const to of SUBJECT_LIFECYCLE_STATES) {
        if (from === to) continue;
        const person = await subject(from);
        const outcome = await codeOf(asRuntime(`UPDATE "Subject" SET "lifecycleState" = '${to}' WHERE "id" = $1`, person.id));
        if (canTransitionSubject(from, to)) {
          expect(outcome, `${from} -> ${to}`).toBe("OK");
          const row = await read(person.id);
          expect(row.lifecycleState, `${from} -> ${to}`).toBe(to);
          expect(row.lifecycleVersion, `${from} -> ${to}`).toBe(2);
          expect(ageSeconds(row.lifecycleChangedAt), `${from} -> ${to}`).toBeLessThan(120);
        } else {
          expect(outcome, `${from} -> ${to}`).toBe("SUBJECT_LIFECYCLE_TRANSITION_INVALID");
          expect((await read(person.id)).lifecycleState, `${from} -> ${to}`).toBe(from);
        }
      }
    }
    // RETIRED is terminal: no state leaves it, so a pseudonymized person is never moved back into an active state.
    expect(SUBJECT_LIFECYCLE_STATES.filter((to) => to !== "RETIRED" && canTransitionSubject("RETIRED", to))).toEqual([]);
  }, 300_000);

  it("the caller's ROLLBACK undoes a stamped transition", async () => {
    const person = await subject("ACTIVE");
    const before = await read(person.id);
    const rollback = new Error("caller rollback");
    await expect(rawPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${scope.organizationId}, true), set_config('app.tenant_id', ${scope.tenantId}, true)`;
      await tx.$executeRawUnsafe(`UPDATE "Subject" SET "lifecycleState" = 'RETIRED' WHERE "id" = $1`, person.id);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await read(person.id)).toEqual(before);
  }, 60_000);

  it("the guard is owner-only, and row-level security still applies to the runtime role", async () => {
    const [privileges] = await rawPrisma.$queryRaw<Array<{ guard: boolean }>>`
      SELECT has_function_privilege('app_user', 'public.luxia_subject_lifecycle_guard()', 'EXECUTE') AS guard`;
    expect(privileges.guard).toBe(false);
    // Another organization's subject stays invisible and untouched, as before the guard.
    const other = await owner.organization.create({ data: { name: "Other", slug: `other-${suffix}` } });
    const otherTenant = await owner.tenant.create({ data: { organizationId: other.id, name: "Production" } });
    const outside = await owner.subject.create({ data: { organizationId: other.id, tenantId: otherTenant.id, type: "HUMAN", name: "Outside", lifecycleState: "ACTIVE" } });
    expect(await asRuntime(`UPDATE "Subject" SET "lifecycleState" = 'RETIRED' WHERE "id" = $1`, outside.id)).toBe(0);
    expect((await read(outside.id)).lifecycleState).toBe("ACTIVE");
  }, 60_000);

  it("drill: the migration applies on a scratch database, the rollback restores the catalog exactly, and it applies again", () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_lifecycle_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const catalog = () => psqlOk(url, ["-c", `SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, '-'), ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`,
      "-c", `SELECT string_agg(tgname || ':' || md5(pg_get_triggerdef(oid)), ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal`]);
    try {
      for (const dir of readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d) && d < NEW).sort())
        psqlOk(url, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      const before = catalog();
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(catalog()).not.toBe(before);
      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(catalog()).toBe(before);
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(catalog()).not.toBe(before);
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 240_000);
});
