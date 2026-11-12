// D8.2 (docs/engineering/PRIVATE-BETA-SCOPE.md, section 4.3): the hold register, on PostgreSQL with the real roles.
// A hold takes precedence over every deletion path: R4 and R6 skip a held organization and journal the skip, R7 fails
// while a hold is active, and a hold past its review date is still skipped (the acceptance test of section 4.3). Holds
// are written by the owner only, through functions that also write an append-only history.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261112130000_retention_hold_register";
const ROLLBACK = "docs/operations/RETENTION-HOLD-REGISTER-ROLLBACK.sql";
const STATUS_ROLLBACK = "docs/operations/RETENTION-STATUS-ROLLBACK.sql";
const suffix = randomUUID().slice(0, 8);
const DAY = 86_400_000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let owner: PrismaClient;
let orgs = 0;

const codeOf = (promise: Promise<unknown>) => promise.then(() => "OK", (error: { message?: string }) => /[A-Z][A-Z0-9_]{5,}/.exec(String(error.message))?.[0] ?? String(error.message));
const denied = (promise: Promise<unknown>) => promise.then(() => "ACCEPTED", (error: { message?: string }) => (/permission denied/i.test(String(error.message)) ? "DENIED" : String(error.message)));
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

/** These tests run global purges: they refuse anything but a local database with a test name (luxia_*; Production is neondb). */
function requireTestDatabase() {
  for (const url of [process.env.DATABASE_MIGRATION_URL, process.env.DATABASE_URL]) {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || !/^\/luxia_\w+$/.test(new URL(url).pathname)) throw new Error("ISOLATED_DB_REQUIRED");
  }
}
function psql(url: string, args: string[]) {
  const target = new URL(url); target.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8" });
}
function psqlOk(url: string, args: string[]) {
  const result = psql(url, args);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr ?? result.error}`);
  return result.stdout.replace(/\r/g, "").trim();
}

type Org = { organizationId: string; tenantId: string; admin: string; local: string };
async function organization(): Promise<Org> {
  const organizationId = randomUUID(), tenantId = randomUUID();
  await owner.organization.create({ data: { id: organizationId, name: "D8.2 hold", slug: `d82-${suffix}-${++orgs}` } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const local = await owner.providerConnection.create({ data: { organizationId, providerType: "LUXIA_LOCAL", externalScopeId: `local-${organizationId}`, name: "Local" } });
  await owner.providerConnectionTenantScope.create({ data: { organizationId, tenantId, providerConnectionId: local.id } });
  const admin = await owner.subject.create({ data: { organizationId, tenantId, type: "HUMAN", name: "Admin", lifecycleState: "ACTIVE" } });
  return { organizationId, tenantId, admin: admin.id, local: local.id };
}
const scope = (org: Org) => ({ organizationId: org.organizationId, tenantId: org.tenantId });

/** An invitation finished `finished` days ago and created `created` days ago, dated as a superuser would (guard skipped). */
async function invitation(org: Org, created: number, finished: number) {
  const invitee = await owner.subject.create({ data: { ...scope(org), type: "HUMAN", name: "Invitee", lifecycleState: "PROVISIONING" } });
  const row = await owner.invitation.create({ data: { ...scope(org), subjectId: invitee.id, tokenHash: sha(randomUUID()), role: "MEMBER", invitedBySubjectId: org.admin } });
  await owner.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRawUnsafe(`UPDATE "Invitation" SET "createdAt" = (now() AT TIME ZONE 'UTC') - $2::float8 * interval '1 day',
        "expiresAt" = (now() AT TIME ZONE 'UTC') - $3::float8 * interval '1 day' WHERE "id" = $1`, row.id, created, finished);
  });
  return row.id;
}
/** A person retired `days` ago, with a local sign-in name: what R6 pseudonymizes. */
async function retired(org: Org, days: number) {
  const subject = await owner.subject.create({ data: { ...scope(org), type: "HUMAN", name: `Leaver ${randomUUID().slice(0, 6)}`, lifecycleState: "ACTIVE" } });
  const account = await owner.identityAccount.create({ data: { ...scope(org), subjectId: subject.id, providerConnectionId: org.local, externalObjectId: randomUUID() } });
  await owner.localIdentity.create({ data: { ...scope(org), identityAccountId: account.id, principalName: `leaver-${randomUUID().slice(0, 8)}` } });
  await owner.subject.update({ where: { id: subject.id }, data: { lifecycleState: "RETIRED", lifecycleChangedAt: new Date(Date.now() - days * DAY) } });
  return subject.id;
}
const invitationsLeft = async (ids: string[]) => (await owner.invitation.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id).sort();
const nameOf = async (id: string) => (await owner.subject.findUniqueOrThrow({ where: { id }, select: { name: true } })).name;
const place = (org: Org, basis: string, review: string, db: PrismaClient = owner) =>
  db.$executeRawUnsafe(`SELECT luxia_retention_hold_place($1, $2, $3::date)`, org.organizationId, basis, review);
const renew = (org: Org, basis: string, review: string) =>
  owner.$executeRawUnsafe(`SELECT luxia_retention_hold_renew($1, $2, $3::date)`, org.organizationId, basis, review);
const release = (org: Org, basis: string) => owner.$executeRawUnsafe(`SELECT luxia_retention_hold_release($1, $2)`, org.organizationId, basis);
const history = async (org: Org) => (await owner.$queryRawUnsafe<Array<{ action: string; basis: string; review: string | null; scope: string }>>(
  `SELECT "action", "basisReference" AS basis, "reviewDate"::text AS review, "scope" FROM "RetentionHoldEvent" WHERE "heldOrganizationId" = $1 ORDER BY "id"`, org.organizationId));
/** The last run record of a mechanism. */
const lastRun = async (mechanism: string) => (await owner.$queryRawUnsafe<Array<{ counts: Record<string, number | string> }>>(
  `SELECT "counts" FROM "RetentionRun" WHERE "counts"->>'mechanism' = $1 ORDER BY "id" DESC LIMIT 1`, mechanism))[0].counts;
/** R4 and R6 enforce as the owner in its own session (the runtime role is still dry run only), until nothing is left. */
async function drain(fn: "luxia_retention_purge_invitations" | "luxia_retention_pseudonymize_retired", key: string) {
  for (let i = 0; i < 20; i++) {
    const [row] = await owner.$queryRawUnsafe<Array<{ counts: Record<string, number> }>>(`SELECT ${fn}(5000, true) AS counts`);
    if (row.counts[key] === 0) return;
  }
  throw new Error("DRAIN_DID_NOT_CONVERGE");
}
type Mechanism = { eligible: number; overdue: number; oldestHours: number; held?: number };
type Status = { R3: Mechanism; R4: Mechanism; R6: Mechanism; holds: { active: number; overdueReview: number } };
const status = async () => (await rawPrisma.$queryRawUnsafe<Array<{ status: Status }>>("SELECT luxia_retention_status() AS status"))[0].status;

describe.runIf(enabled)("D8.2: hold register (PostgreSQL)", () => {
  beforeAll(async () => {
    requireTestDatabase();
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("the runtime role has no access: register, history, hold check and operator functions", async () => {
    const org = await organization();
    expect(await denied(rawPrisma.$queryRawUnsafe(`SELECT count(*) FROM "RetentionHold"`))).toBe("DENIED");
    expect(await denied(rawPrisma.$queryRawUnsafe(`SELECT count(*) FROM "RetentionHoldEvent"`))).toBe("DENIED");
    expect(await denied(rawPrisma.$executeRawUnsafe(`INSERT INTO "RetentionHold" ("organizationId", "basisReference", "reviewDate") VALUES ($1, 'HOLD-1', CURRENT_DATE + 1)`, org.organizationId))).toBe("DENIED");
    expect(await denied(rawPrisma.$queryRawUnsafe(`SELECT luxia_retention_held($1)`, org.organizationId))).toBe("DENIED");
    expect(await denied(place(org, "HOLD-RT-1", inDays(30), rawPrisma as unknown as PrismaClient))).toBe("DENIED");
    expect(await denied(rawPrisma.$executeRawUnsafe(`SELECT luxia_retention_hold_release($1, 'HOLD-RT-1')`, org.organizationId))).toBe("DENIED");
    const [{ n }] = await owner.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "RetentionHold" WHERE "organizationId" = $1`, org.organizationId);
    expect(n).toBe(0);
  });

  it("the runtime role still creates and updates invitations of a held organization: the hold check is reached only by DELETE", async () => {
    const org = await organization();
    await place(org, "HOLD-INV-1", inDays(30));
    const invitee = await owner.subject.create({ data: { ...scope(org), type: "HUMAN", name: "Invitee", lifecycleState: "PROVISIONING" } });
    const id = randomUUID();
    const asRuntime = <T>(fn: (tx: Parameters<Parameters<typeof rawPrisma.$transaction>[0]>[0]) => Promise<T>) => rawPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${org.organizationId}, true), set_config('app.tenant_id', ${org.tenantId}, true)`;
      return fn(tx);
    });
    expect(await codeOf(asRuntime((tx) => tx.invitation.create({ data: { id, ...scope(org), subjectId: invitee.id, tokenHash: sha(randomUUID()), role: "MEMBER", invitedBySubjectId: org.admin } })))).toBe("OK");
    expect(await codeOf(asRuntime((tx) => tx.$executeRawUnsafe(`UPDATE "Invitation" SET "revokedAt" = now() WHERE "id" = $1`, id)))).toBe("OK");
  });

  it("place validates its arguments and writes the history; one active hold per organization", async () => {
    const org = await organization();
    expect(await place(org, "free text with spaces", inDays(30)).then(() => "OK", (error: Error) => error.message)).toMatch(/RetentionHold_basis/);
    expect(await codeOf(place(org, "HOLD-OLD-1", inDays(-1)))).toBe("RETENTION_HOLD_REVIEW_DATE_INVALID");
    expect(await codeOf(place({ ...org, organizationId: randomUUID() }, "HOLD-NONE-1", inDays(30)))).toBe("RETENTION_HOLD_ORGANIZATION_UNKNOWN");
    expect(await codeOf(place(org, "HOLD-A-1", today()))).toBe("OK"); // a review date of today is allowed
    expect(await codeOf(place(org, "HOLD-A-2", inDays(30)))).toBe("RETENTION_HOLD_ALREADY_ACTIVE");
    expect(await history(org)).toEqual([{ action: "PLACE", basis: "HOLD-A-1", review: today(), scope: "ORGANIZATION" }]);
    const [row] = await owner.$queryRawUnsafe<Array<{ scope: string }>>(`SELECT "scope" FROM "RetentionHold" WHERE "organizationId" = $1`, org.organizationId);
    expect(row.scope).toBe("ORGANIZATION");
  });

  it("R4 skips a held organization, journals the skip, and the guard refuses the owner's direct DELETE of a held row", async () => {
    const held = await organization(), free = await organization();
    const heldRows = [await invitation(held, 40, 33), await invitation(held, 45, 38)];
    const freeRow = await invitation(free, 40, 33);
    await place(held, "HOLD-R4-1", inDays(30));
    await drain("luxia_retention_purge_invitations", "invitations");
    expect(await invitationsLeft([...heldRows, freeRow])).toEqual([...heldRows].sort());
    expect(Number((await lastRun("R4")).held)).toBeGreaterThanOrEqual(2);
    // The guard's own check, for a DELETE that does not go through R4.
    expect(await codeOf(owner.$executeRawUnsafe(`DELETE FROM "Invitation" WHERE "id" = $1`, heldRows[0]))).toBe("INVITATION_IMMUTABLE");
    expect(await invitationsLeft(heldRows)).toEqual([...heldRows].sort());
    // After a documented release, the next run deletes them.
    await release(held, "RELEASE-R4-1");
    await drain("luxia_retention_purge_invitations", "invitations");
    expect(await invitationsLeft(heldRows)).toEqual([]);
  }, 60_000);

  it("R6 skips a held organization and journals the skip", async () => {
    const held = await organization(), free = await organization();
    const kept = await retired(held, 40), done = await retired(free, 40);
    const keptName = await nameOf(kept);
    await place(held, "HOLD-R6-1", inDays(30));
    await drain("luxia_retention_pseudonymize_retired", "subjects");
    expect(await nameOf(kept)).toBe(keptName);
    expect(await nameOf(done)).toBe(`Ancien membre ${sha(done).slice(0, 8)}`);
    expect(Number((await lastRun("R6")).held)).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("acceptance test of section 4.3: a hold past its review date is still skipped by every scheduled deletion, and reported", async () => {
    const org = await organization();
    const row = await invitation(org, 40, 33);
    const person = await retired(org, 40);
    const name = await nameOf(person);
    await place(org, "HOLD-OVERDUE-1", inDays(1));
    // The review date passes: set directly, as time would, through the register's write marker (test only).
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('luxia.retention_hold_write', 'on', true)`);
      await tx.$executeRawUnsafe(`UPDATE "RetentionHold" SET "reviewDate" = CURRENT_DATE - 5 WHERE "organizationId" = $1`, org.organizationId);
    });
    await drain("luxia_retention_purge_invitations", "invitations");
    await drain("luxia_retention_pseudonymize_retired", "subjects");
    expect(await invitationsLeft([row])).toEqual([row]);
    expect(await nameOf(person)).toBe(name);
    const now = await status();
    expect(now.holds.overdueReview).toBeGreaterThanOrEqual(1);
    expect(now.holds.active).toBeGreaterThanOrEqual(now.holds.overdueReview);
    // Renewing sets a new review date; the history keeps both steps.
    await renew(org, "HOLD-OVERDUE-2", inDays(60));
    expect((await history(org)).map((e) => `${e.action}:${e.basis}`)).toEqual(["PLACE:HOLD-OVERDUE-1", "RENEW:HOLD-OVERDUE-2"]);
    expect(await codeOf(renew(org, "HOLD-OVERDUE-3", inDays(-1)))).toBe("RETENTION_HOLD_REVIEW_DATE_INVALID");
  }, 60_000);

  it("the status counts what R4 and R6 may act on, without held organizations, and reports what holds keep", async () => {
    const org = await organization();
    const before = await status();
    await invitation(org, 42, 35);
    await retired(org, 40);
    const unheld = await status();
    expect(unheld.R4.eligible - before.R4.eligible).toBe(1);
    expect(unheld.R6.eligible - before.R6.eligible).toBe(1);
    await place(org, "HOLD-STATUS-1", inDays(30));
    const held = await status();
    expect(held.R4.eligible).toBe(before.R4.eligible);
    expect(held.R6.eligible).toBe(before.R6.eligible);
    expect(held.R4.overdue).toBe(before.R4.overdue);
    expect(held.R6.overdue).toBe(before.R6.overdue);
    expect(held.R4.held! - (before.R4.held ?? 0)).toBe(1);
    expect(held.R6.held! - (before.R6.held ?? 0)).toBe(1);
    expect(held.holds.active - before.holds.active).toBe(1);
    expect(Object.keys(held.R3).sort()).toEqual(["eligible", "oldestHours", "overdue"]); // R3 has no hold
  }, 60_000);

  it("R7 fails while a hold is active, and the organization stays whole; after the release it runs, and the history outlives it", async () => {
    const org = await organization();
    await invitation(org, 2, -5);
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRawUnsafe(`UPDATE "Organization" SET "status" = 'CLOSED' WHERE "id" = $1`, org.organizationId);
    });
    await place(org, "HOLD-R7-1", inDays(30));
    expect(await codeOf(owner.$queryRawUnsafe(`SELECT luxia_organization_erase($1)::text`, org.organizationId))).toBe("ERASURE_INCOMPLETE");
    const [{ n }] = await owner.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "Invitation" WHERE "organizationId" = $1`, org.organizationId);
    expect(n).toBe(1);
    await release(org, "RELEASE-R7-1");
    expect(await codeOf(owner.$queryRawUnsafe(`SELECT luxia_organization_erase($1)::text`, org.organizationId))).toBe("OK");
    expect((await history(org)).map((e) => e.action)).toEqual(["PLACE", "RELEASE"]);
    expect(await codeOf(release(org, "RELEASE-R7-2"))).toBe("RETENTION_HOLD_NOT_ACTIVE");
  }, 60_000);

  // A guard against mistakes: the owner session stays trusted (it could set the functions' marker, as this file does to
  // move a review date, or disable a trigger), as for R7.
  it("the register changes through the operator functions: a direct write without their marker, the owner's included, is refused", async () => {
    const org = await organization(), other = await organization();
    await place(org, "HOLD-DIRECT-1", inDays(30));
    expect(await codeOf(owner.$executeRawUnsafe(`DELETE FROM "RetentionHold" WHERE "organizationId" = $1`, org.organizationId))).toBe("RETENTION_HOLD_WRITE_THROUGH_FUNCTIONS_ONLY");
    expect(await codeOf(owner.$executeRawUnsafe(`UPDATE "RetentionHold" SET "reviewDate" = CURRENT_DATE + 999 WHERE "organizationId" = $1`, org.organizationId))).toBe("RETENTION_HOLD_WRITE_THROUGH_FUNCTIONS_ONLY");
    expect(await codeOf(owner.$executeRawUnsafe(`INSERT INTO "RetentionHold" ("organizationId", "basisReference", "reviewDate") VALUES ($1, 'HOLD-DIRECT-2', CURRENT_DATE + 1)`, other.organizationId))).toBe("RETENTION_HOLD_WRITE_THROUGH_FUNCTIONS_ONLY");
    expect(await codeOf(owner.$executeRawUnsafe(`TRUNCATE "RetentionHold"`))).toBe("RETENTION_HOLD_WRITE_THROUGH_FUNCTIONS_ONLY");
    // The marker does not outlive a function call.
    expect(await codeOf(owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT luxia_retention_hold_renew($1, 'HOLD-DIRECT-3', $2::date)`, org.organizationId, inDays(40));
      await tx.$executeRawUnsafe(`DELETE FROM "RetentionHold" WHERE "organizationId" = $1`, org.organizationId);
    }))).toBe("RETENTION_HOLD_WRITE_THROUGH_FUNCTIONS_ONLY");
    const [{ n }] = await owner.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "RetentionHold" WHERE "organizationId" = $1`, org.organizationId);
    expect(n).toBe(1);
    expect((await history(org)).map((e) => e.action)).toEqual(["PLACE"]);
    // Renewing or releasing what is not held is refused, and writes no history.
    expect(await codeOf(renew(other, "HOLD-DIRECT-4", inDays(30)))).toBe("RETENTION_HOLD_NOT_ACTIVE");
    expect(await codeOf(release(other, "RELEASE-DIRECT-1"))).toBe("RETENTION_HOLD_NOT_ACTIVE");
    expect(await history(other)).toEqual([]);
  });

  it("the history is append-only for everyone, the owner included", async () => {
    const org = await organization();
    await place(org, "HOLD-HIST-1", inDays(30));
    expect(await codeOf(owner.$executeRawUnsafe(`UPDATE "RetentionHoldEvent" SET "basisReference" = 'FORGED-1' WHERE "heldOrganizationId" = $1`, org.organizationId))).toBe("RETENTION_HOLD_HISTORY_APPEND_ONLY");
    expect(await codeOf(owner.$executeRawUnsafe(`DELETE FROM "RetentionHoldEvent" WHERE "heldOrganizationId" = $1`, org.organizationId))).toBe("RETENTION_HOLD_HISTORY_APPEND_ONLY");
    expect(await codeOf(owner.$executeRawUnsafe(`TRUNCATE "RetentionHoldEvent"`))).toBe("RETENTION_HOLD_HISTORY_APPEND_ONLY");
    expect(await history(org)).toHaveLength(1);
  });

  // Codex, review of #192: a transaction that took its snapshot before the hold would read the register as it was.
  it("a transaction begun before the hold cannot run R4 or R6, nor delete, on its old snapshot: READ COMMITTED only", async () => {
    const org = await organization();
    const row = await invitation(org, 40, 33);
    const person = await retired(org, 40);
    const name = await nameOf(person);
    let placed = false;
    for (const isolationLevel of ["RepeatableRead", "Serializable"] as const) {
      for (const sql of [`SELECT luxia_retention_pseudonymize_retired(5000, true)::text`, `SELECT luxia_retention_purge_invitations(5000, true)::text`,
        `DELETE FROM "Invitation" WHERE "id" = '${row}'`]) {
        const outcome = await codeOf(owner.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "RetentionHold"`); // the transaction's snapshot: no hold yet
          // The hold is placed and committed by another session; this transaction holds no retention lock yet.
          if (!placed) { await place(org, "HOLD-SNAPSHOT-1", inDays(30)); placed = true; }
          await tx.$executeRawUnsafe(sql);
        }, { isolationLevel, timeout: 30_000 }));
        expect(outcome, `${isolationLevel}: ${sql}`).toBe("RETENTION_REQUIRES_READ_COMMITTED");
      }
    }
    expect(await nameOf(person)).toBe(name);
    expect(await invitationsLeft([row])).toEqual([row]);
    // At READ COMMITTED, the same calls run and skip the held organization.
    await drain("luxia_retention_pseudonymize_retired", "subjects");
    await drain("luxia_retention_purge_invitations", "invitations");
    expect(await nameOf(person)).toBe(name);
    expect(await invitationsLeft([row])).toEqual([row]);
  }, 120_000);

  it("placing a hold waits for a running R4 or R6 call: no deletion that started before the hold outlives it", async () => {
    const org = await organization();
    for (const key of ["luxia-retention-purge-invitations", "luxia-retention-pseudonymize-retired"]) {
      const outcome = await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key); // a purge "running" here
        const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
        try {
          return await codeOf(other.$transaction(async (t2) => {
            await t2.$executeRawUnsafe(`SET LOCAL lock_timeout = '500ms'`);
            await t2.$executeRawUnsafe(`SELECT luxia_retention_hold_place($1, 'HOLD-WAIT-1', $2::date)`, org.organizationId, inDays(30));
          }));
        } finally { await other.$disconnect(); }
      }, { timeout: 30_000 });
      expect(outcome, key).toMatch(/lock timeout|55P03/i);
    }
    expect(await history(org)).toEqual([]);
  }, 60_000);

  it("drill: the migration applies on a scratch database, the rollback restores the catalog exactly, and it applies again", () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_d82_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const catalog = () => psqlOk(url, ["-c", `SELECT string_agg(c.relname::text || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '-'), ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`,
      "-c", `SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, '-'), ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`,
      "-c", `SELECT string_agg(tgname || ':' || md5(pg_get_triggerdef(oid)), ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal`]);
    try {
      const prior = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
      for (const dir of prior) psqlOk(url, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      const before = catalog();
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(catalog()).not.toBe(before);
      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(catalog()).toBe(before);
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      // Once a hold has been recorded, even released, the rollback refuses: its history is never dropped.
      const org = randomUUID();
      psqlOk(url, ["-c", `INSERT INTO "Organization" ("id", "name", "slug", "updatedAt") VALUES ('${org}', 'Drill', 'drill-${suffix}', now())`,
        "-c", `SELECT luxia_retention_hold_place('${org}', 'HOLD-DRILL-1', CURRENT_DATE + 1)`, "-c", `SELECT luxia_retention_hold_release('${org}', 'RELEASE-DRILL-1')`]);
      const refused = psql(url, ["-1", "-f", ROLLBACK]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/ROLLBACK_HOLD_REGISTER_IN_USE/);
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 240_000);

  it("drill with Prisma's real history: only the last migration rolls back; in order, both come back with migrate deploy", () => {
    const prisma = createRequire(import.meta.url).resolve("prisma/build/index.js");
    const deploy = (url: string) => {
      const result = spawnSync(process.execPath, [prisma, "migrate", "deploy"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } });
      if (result.status !== 0) throw new Error(`migrate deploy failed: ${result.stdout}${result.stderr}`);
    };
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_d82h_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const state = () => psqlOk(url, ["-c", `SELECT to_regclass('public."RetentionHold"') IS NOT NULL`,
      "-c", `SELECT count(*) FROM "_prisma_migrations" WHERE "migration_name" IN ('${NEW}', '20261112100000_retention_status') AND "finished_at" IS NOT NULL`]).split("\n");
    try {
      deploy(url);
      expect(state()).toEqual(["t", "2"]);
      // The status rollback is refused while the hold register is applied after it.
      const refused = psql(url, ["-1", "-f", STATUS_ROLLBACK]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/ROLLBACK_NOT_LATEST_MIGRATION/);
      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(state()).toEqual(["f", "1"]);
      psqlOk(url, ["-1", "-f", STATUS_ROLLBACK]);
      expect(state()).toEqual(["f", "0"]);
      deploy(url);
      expect(state()).toEqual(["t", "2"]);
      expect(psqlOk(url, ["-c", `SELECT (luxia_retention_status() ? 'holds')::text`])).toBe("true");
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 240_000);
});
