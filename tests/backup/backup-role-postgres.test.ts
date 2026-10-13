import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Independent backup (docs/operations/INDEPENDENT-BACKUP-ARCHITECTURE.md): luxia_backup reads every row of every
// tenant, and can change nothing. Runs against a database where scripts/backup/luxia-backup-role.sql was applied.
const backupUrl = process.env.LUXIA_BACKUP_DATABASE_URL;
let backup: PrismaClient;
let owner: PrismaClient;
let tables: string[];
const DENIED = /permission denied|must be owner|42501/;
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const ROLLBACK = new Error("rollback");

/** Runs one statement as luxia_backup in a READ WRITE transaction (overriding the role's read-only default, to prove
 * the privilege itself is missing), always rolled back. Returns the error message, or ACCEPTED. */
async function attempt(sql: string, { readWrite = true } = {}) {
  let outcome = "";
  await backup.$transaction(async (tx: Prisma.TransactionClient) => {
    if (readWrite) await tx.$executeRawUnsafe("SET TRANSACTION READ WRITE");
    outcome = await tx.$executeRawUnsafe(sql).then(() => "ACCEPTED", (error: Error) => error.message);
    throw ROLLBACK;
  }).catch((error) => { if (error !== ROLLBACK) throw error; });
  return outcome;
}

describe.runIf(Boolean(backupUrl))("luxia_backup, the independent backup role (PostgreSQL)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL) throw new Error("ISOLATED_DB_REQUIRED");
    backup = new PrismaClient({ datasources: { db: { url: backupUrl } } });
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    tables = (await owner.$queryRaw<Array<{ name: string }>>`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY c.relname`).map(row => row.name);
    expect(tables.length).toBeGreaterThan(40);
  });
  afterAll(async () => { await backup?.$disconnect(); await owner?.$disconnect(); });

  it("has only what a backup needs: login, BYPASSRLS, read-only by default, no other attribute, no membership", async () => {
    const [role] = await backup.$queryRaw<Array<Record<string, unknown>>>`
      SELECT current_user AS name, r.rolsuper AS super, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole,
        r.rolreplication AS replication, r.rolinherit AS inherit, r.rolbypassrls AS bypassrls, r.rolcanlogin AS login,
        (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
        current_setting('default_transaction_read_only') AS read_only
      FROM pg_roles r WHERE r.rolname = current_user`;
    expect(role).toEqual({ name: "luxia_backup", super: false, createdb: false, createrole: false, replication: false,
      inherit: false, bypassrls: true, login: true, memberships: 0, read_only: "on" });
  });

  it("reads every table completely with row-level security off: no tenant row is filtered out", async () => {
    const counts = async (client: PrismaClient) => client.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe("SET LOCAL row_security = off");
      const result: Record<string, number> = {};
      for (const table of tables) {
        const [row] = await tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM public.${quote(table)}`);
        result[table] = row.n;
      }
      return result;
    }, { timeout: 120_000 });
    const seen = await counts(backup);
    expect(seen).toEqual(await counts(owner));
    // The fixtures of the other suites leave tenant rows behind, so this proves more than empty tables.
    expect(seen.Subject).toBeGreaterThan(0);
    expect(seen.CanonicalAdminAuditEvent).toBeGreaterThan(0);
  });

  it("holds SELECT only, on every table and sequence, without grant option, and executes no LUXIA function", async () => {
    const rights = await owner.$queryRaw<Array<{ name: string; select: boolean; write: boolean; grantable: boolean }>>`
      SELECT c.relname AS name, has_table_privilege('luxia_backup', c.oid, 'SELECT') AS select,
        has_table_privilege('luxia_backup', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS write,
        has_table_privilege('luxia_backup', c.oid, 'SELECT WITH GRANT OPTION') AS grantable
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S')`;
    for (const row of rights) expect(row, row.name).toMatchObject({ select: true, write: false, grantable: false });
    const [schema] = await owner.$queryRaw<Array<{ create: boolean; usage: boolean; database_create: boolean }>>`
      SELECT has_schema_privilege('luxia_backup', 'public', 'CREATE') AS create, has_schema_privilege('luxia_backup', 'public', 'USAGE') AS usage,
        has_database_privilege('luxia_backup', current_database(), 'CREATE') AS database_create`;
    expect(schema).toEqual({ create: false, usage: true, database_create: false });
    const functions = await owner.$queryRaw<Array<{ proname: string }>>`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'luxia_%' AND has_function_privilege('luxia_backup', p.oid, 'EXECUTE')`;
    expect(functions).toEqual([]);
  });

  it("is refused every write, lock and schema change, even after switching its transaction to READ WRITE", async () => {
    const [ownerName] = await owner.$queryRaw<Array<{ name: string }>>`SELECT pg_get_userbyid(relowner) AS name FROM pg_class WHERE relname = 'Organization'`;
    const statements = [
      `INSERT INTO "Organization" DEFAULT VALUES`,
      `UPDATE "Organization" SET name = name WHERE false`,
      `DELETE FROM "CanonicalAdminAuditEvent" WHERE false`,
      `DELETE FROM "AuthenticationEvidence" WHERE false`,
      `UPDATE "Session" SET "revokedAt" = now() WHERE false`,
      `UPDATE "LocalRecoveryCode" SET "usedAt" = now() WHERE false`,
      `TRUNCATE "AuthenticationEvidence"`,
      `SELECT 1 FROM "Organization" FOR UPDATE`,
      `LOCK TABLE "Session" IN ACCESS EXCLUSIVE MODE`,
      `CREATE TABLE public.luxia_backup_probe (id int)`,
      `CREATE FUNCTION public.luxia_backup_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
      `ALTER TABLE "Organization" ADD COLUMN luxia_backup_probe int`,
      `ALTER TABLE "CanonicalAdminAuditEvent" DISABLE TRIGGER audit_append_only`,
      `DROP TABLE "Session"`,
      `CREATE SCHEMA luxia_backup_probe`,
      `CREATE ROLE luxia_backup_probe`,
      `ALTER ROLE app_user BYPASSRLS`,
      `SET ROLE ${quote(ownerName.name)}`,
    ];
    for (const sql of statements) expect(await attempt(sql), sql).toMatch(DENIED);
  });

  it("is read-only by default: a write without an explicit READ WRITE stops before the privilege check", async () => {
    expect(await attempt(`UPDATE "Organization" SET name = name WHERE false`, { readWrite: false })).toMatch(/read-only transaction|25006/);
  });
});
