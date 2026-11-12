// Owner-only tables (row-level security forced, no policy) carry two independent barriers for the runtime role: no
// privilege, and row-level security that shows and accepts no row. Two checks, read from the catalog so that a new
// owner-only table is covered without a list:
// 1. the CI database, after the CI bootstrap;
// 2. a disposable database set up the way Production is: app_user exists and the default privileges grant it every new
//    table before the migrations run, then every migration, then the activation gate's own SQL, read from the workflow.
//    CI creates app_user after the migrations, so only this second check sees what the default privileges do.
// In both, app_user holds no privilege on an owner-only table or its sequences, and real statements are refused.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const OWNER_ONLY_QUERY = `
  SELECT c.relname AS name,
    ARRAY(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
          WHERE has_table_privilege('app_user', c.oid, p)) AS privileges,
    ARRAY(SELECT s.relname || ':' || p FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
          CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) p
          WHERE d.refobjid = c.oid AND d.deptype IN ('a', 'i') AND has_sequence_privilege('app_user', s.oid, p)) AS sequences
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND c.relforcerowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
  ORDER BY c.relname`;
type OwnerOnly = { name: string; privileges: string[]; sequences: string[] };
const KNOWN = ["OrganizationErasure", "RetentionRun", "SignupCode", "RateLimitBucket", "RateLimitConfig"];
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function psql(url: string, args: string[], input?: string) {
  const target = new URL(url); target.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8", input });
}
function psqlOk(url: string, args: string[], input?: string) {
  const result = psql(url, args, input);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr ?? result.error}`);
  return result.stdout.replace(/\r/g, "").trim();
}
/** A statement run as app_user: "DENIED" for a privilege refusal, "OK" when it ran. */
function asRuntime(url: string, sql: string) {
  const result = psql(url, ["-c", sql]);
  if (result.status === 0) return "OK";
  return /permission denied/.test(result.stderr) ? "DENIED" : `OTHER: ${result.stderr.trim()}`;
}
/** Statements that touch each owner-only object and the provider tables that are never deleted; all must be refused. */
const ATTEMPTS = [
  `SELECT count(*) FROM "OrganizationErasure"`,
  `INSERT INTO "OrganizationErasure" ("organizationId", "counts") VALUES ('x', '{}')`,
  `UPDATE "OrganizationErasure" SET "counts" = '{}'`,
  `DELETE FROM "OrganizationErasure"`,
  `SELECT nextval('"OrganizationErasure_id_seq"')`,
  `SELECT last_value FROM "OrganizationErasure_id_seq"`,
  `SELECT count(*) FROM "RetentionRun"`,
  `SELECT nextval('"RetentionRun_id_seq"')`,
  `DELETE FROM "ProviderConnection"`,
  `DELETE FROM "ProviderSecretReference"`,
  `TRUNCATE "ProviderConnection" CASCADE`,
];

describe.runIf(enabled)("owner-only tables: no runtime privilege (PostgreSQL)", () => {
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
  afterAll(async () => { await owner.$disconnect(); });

  it("the CI database: no privilege on any owner-only table or its sequences, and real statements are refused", async () => {
    const tables = await owner.$queryRawUnsafe<OwnerOnly[]>(OWNER_ONLY_QUERY);
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(KNOWN));
    expect(tables.filter((t) => t.privileges.length > 0 || t.sequences.length > 0)).toEqual([]);
    for (const sql of ATTEMPTS) expect(asRuntime(process.env.DATABASE_URL!, sql), sql).toBe("DENIED");
  });

  it("a database set up like Production (default privileges first, then the migrations, then the activation gate's SQL)", () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_gate_${randomUUID().slice(0, 8)}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const runtime = new URL(process.env.DATABASE_URL!); runtime.pathname = `/${name}`;
    try {
      // What the gate leaves in Production: every table and sequence the owner creates is granted to app_user on creation.
      psqlOk(url, ["-c", `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user`,
        "-c", `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user`]);
      for (const dir of readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort())
        psqlOk(url, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      // The gate's grant step, exactly as the workflow runs it (its database name replaced).
      const gate = read(".github/workflows/production-activation-gate.yml");
      const block = /Bootstrap least-privilege runtime grants[\s\S]*?<<'SQL'\n([\s\S]*?)\n\s*SQL\n/.exec(gate)?.[1];
      expect(block, "gate SQL block").toBeTruthy();
      psqlOk(url, ["-1"], block!.replace(/^ {10}/gm, "").replace(/DATABASE neondb/g, `DATABASE ${name}`));
      const tables = JSON.parse(psqlOk(url, ["-c", `SELECT coalesce(json_agg(t), '[]') FROM (${OWNER_ONLY_QUERY}) t`])) as OwnerOnly[];
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(KNOWN));
      expect(tables.filter((t) => t.privileges.length > 0 || t.sequences.length > 0)).toEqual([]);
      for (const sql of ATTEMPTS) expect(asRuntime(runtime.toString(), sql), sql).toBe("DENIED");
      // The runtime role still works where it must: a tenant table it is granted, read under row-level security.
      expect(asRuntime(runtime.toString(), `SELECT count(*) FROM "Subject"`)).toBe("OK");
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 300_000);
});
