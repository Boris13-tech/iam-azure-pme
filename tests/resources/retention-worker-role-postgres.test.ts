// D8.4 (issue #150), operator decision of 2026-11-14, option A: the daily retention job runs as its own database role.
// On real roles: app_user, which serves every web request, can execute none of the four retention functions;
// luxia_retention can execute exactly those four and nothing else; and it is no more able to enforce R4 or R6 than
// app_user was, since enforcing stays the owner's in its own session.
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { retentionTestClient } from "../helpers/retention-client";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
const retention = retentionTestClient();

/** The four entry points of the daily job, with a dry-run call for each. */
const ENTRY_POINTS = [
  `SELECT luxia_retention_purge_transactions(10, false)`,
  `SELECT luxia_retention_purge_invitations(10, false)`,
  `SELECT luxia_retention_pseudonymize_retired(10, false)`,
  `SELECT luxia_retention_status()`,
] as const;
const outcome = (promise: Promise<unknown>) => promise.then(() => "OK",
  (error: { message?: string }) => /permission denied/i.test(String(error.message)) ? "DENIED"
    : /[A-Z][A-Z0-9_]{5,}/.exec(String(error.message))?.[0] ?? String(error.message));

describe.runIf(enabled)("D8.4: the retention job has its own role (PostgreSQL)", () => {
  afterAll(async () => { await rawPrisma.$disconnect(); await retention.$disconnect(); await owner.$disconnect(); });

  it("app_user can execute none of the four retention functions", async () => {
    for (const sql of ENTRY_POINTS) expect(await outcome(rawPrisma.$queryRawUnsafe(sql)), sql).toBe("DENIED");
    // Read from the catalog as well, so a grant to app_user through any other path is caught.
    const [privileges] = await owner.$queryRaw<Array<{ granted: string }>>`
      SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '') AS granted FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'luxia_retention%'
        AND has_function_privilege('app_user', p.oid, 'EXECUTE')`;
    expect(privileges.granted).toBe("");
  });

  it("luxia_retention can execute exactly those four, and the job's own run works through it", async () => {
    for (const sql of ENTRY_POINTS) expect(await outcome(retention.$queryRawUnsafe(sql)), sql).toBe("OK");
    // Every function it may execute that is not executable by everyone: exactly the four, compared as a set so no
    // collation order is assumed.
    const granted = await owner.$queryRaw<Array<{ proname: string }>>`
      SELECT p.proname FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('luxia_retention', p.oid, 'EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')`;
    expect(granted.map((row) => row.proname).sort()).toEqual([
      "luxia_retention_pseudonymize_retired", "luxia_retention_purge_invitations",
      "luxia_retention_purge_transactions", "luxia_retention_status",
    ].sort());
  });

  it("the role holds nothing else: no table, no sequence, not even a read", async () => {
    const [reach] = await owner.$queryRaw<Array<{ tables: string; sequences: string }>>`
      SELECT coalesce((SELECT string_agg(c.relname || ':' || p, ',' ORDER BY c.relname) FROM pg_class c
          CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
            AND has_table_privilege('luxia_retention', c.oid, p)), '') AS tables,
        coalesce((SELECT string_agg(c.relname || ':' || p, ',' ORDER BY c.relname) FROM pg_class c
          CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) p
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
            AND has_sequence_privilege('luxia_retention', c.oid, p)), '') AS sequences`;
    expect(reach).toEqual({ tables: "", sequences: "" });
    // Measured from the role itself, which is what matters: a direct read of a tenant table is refused.
    for (const sql of [`SELECT count(*) FROM "Subject"`, `SELECT count(*) FROM "RetentionRun"`, `SELECT count(*) FROM "_prisma_migrations"`])
      expect(await outcome(retention.$queryRawUnsafe(sql)), sql).toBe("DENIED");
  });

  it("the role is restricted, and cannot enforce R4 or R6 any more than app_user could", async () => {
    const [role] = await retention.$queryRaw<Array<{ posture: string }>>`
      SELECT current_user || ' superuser=' || r.rolsuper || ' bypassrls=' || r.rolbypassrls || ' createrole=' || r.rolcreaterole || ' createdb=' || r.rolcreatedb AS posture
        FROM pg_roles r WHERE r.rolname = current_user`;
    expect(role.posture).toBe("luxia_retention superuser=false bypassrls=false createrole=false createdb=false");
    // Enforcing stays the owner's in its own session: a definer call changes current_user, never session_user.
    expect(await outcome(retention.$queryRawUnsafe(`SELECT luxia_retention_purge_invitations(10, true)`))).toBe("RETENTION_R4_ENFORCE_NOT_ACTIVATED");
    expect(await outcome(retention.$queryRawUnsafe(`SELECT luxia_retention_pseudonymize_retired(10, true)`))).toBe("RETENTION_R6_ENFORCE_NOT_ACTIVATED");
    // R3 does enforce for the job, as before: that is the one mechanism already enforcing.
    expect(await outcome(retention.$queryRawUnsafe(`SELECT luxia_retention_purge_transactions(10, true)`))).toBe("OK");
  });

  // Codex F1, review of #196: asking only about app_user's own effective privilege misses a role it can become.
  // A membership permits SET ROLE even when it is not inherited, so the gate's posture query asks about every
  // reachable role. Run here exactly as the gate runs it, against a database where that path really exists.
  const POSTURE = `
    SELECT coalesce(string_agg(DISTINCT p.proname || ' as ' || r.rolname, ', '), '') AS reachable
    FROM pg_proc p CROSS JOIN pg_roles r
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'luxia_retention%'
      AND pg_has_role('app_user', r.oid, 'MEMBER') AND has_function_privilege(r.oid, p.oid, 'EXECUTE')`;

  it("the gate's posture query sees a retention function app_user can only reach by SET ROLE", async () => {
    const reachable = async () => (await owner.$queryRawUnsafe<Array<{ reachable: string }>>(POSTURE))[0].reachable;
    expect(await reachable()).toBe("");
    // The narrower question, the one the first version of the check asked, stays empty throughout: that is the hole.
    const asAppUserOnly = async () => (await owner.$queryRaw<Array<{ granted: string }>>`
      SELECT coalesce(string_agg(p.proname, ', ' ORDER BY p.proname), '') AS granted FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'luxia_retention%'
        AND has_function_privilege('app_user', p.oid, 'EXECUTE')`)[0].granted;
    // The membership is made non-inherited, which is where the two questions part: has_function_privilege follows
    // inheritance, so it answers "no" while SET ROLE still carries app_user into the role and its privileges.
    await owner.$executeRawUnsafe(`ALTER ROLE app_user NOINHERIT`);
    await owner.$executeRawUnsafe(`GRANT luxia_retention TO app_user`);
    try {
      const seen = await reachable();
      expect(seen).toContain("luxia_retention_purge_transactions as luxia_retention");
      expect(seen).toContain("luxia_retention_status as luxia_retention");
      expect(await asAppUserOnly()).toBe("");
      // And the path is real, not only a catalog entry: app_user reaches the function through SET ROLE.
      expect(await outcome(rawPrisma.$queryRawUnsafe(`SET ROLE luxia_retention`))).toBe("OK");
      expect(await outcome(rawPrisma.$queryRawUnsafe(`SELECT luxia_retention_status()`))).toBe("OK");
    } finally {
      await rawPrisma.$executeRawUnsafe(`RESET ROLE`);
      await owner.$executeRawUnsafe(`REVOKE luxia_retention FROM app_user`);
      await owner.$executeRawUnsafe(`ALTER ROLE app_user INHERIT`);
    }
    expect(await reachable()).toBe("");
  });

  // Codex F1, second review of #196: the validation enumerated attributes, memberships and ownership, so a role of
  // that name already holding a privilege on an object passed it and kept that privilege. Run the migration's own
  // validation block against this database, which is the state the migration leaves behind, then against seeded
  // excess privileges.
  it("the migration's validation refuses a role of that name holding anything beyond what it grants", async () => {
    const migration = readFileSync("prisma/migrations/20261114120000_retention_worker_role/migration.sql", "utf8");
    const from = migration.indexOf("DO $$");
    const validation = migration.slice(from, migration.indexOf("END $$;", from) + "END $$;".length);
    expect(validation).toContain("RETENTION_ROLE_UNSAFE");
    const validate = () => outcome(owner.$executeRawUnsafe(validation));
    // Applied where it has already run: what the role holds is exactly what this migration gave it.
    expect(await validate()).toBe("OK");
    const database = (await owner.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`)[0].name;
    const seeds: Array<[string, string, string]> = [
      [`GRANT TRUNCATE ON "RetentionRun" TO luxia_retention`, `REVOKE TRUNCATE ON "RetentionRun" FROM luxia_retention`, "TRUNCATE on the relation RetentionRun"],
      [`GRANT SELECT ON "Subject" TO luxia_retention`, `REVOKE SELECT ON "Subject" FROM luxia_retention`, "SELECT on the relation Subject"],
      [`GRANT CREATE ON SCHEMA public TO luxia_retention`, `REVOKE CREATE ON SCHEMA public FROM luxia_retention`, "CREATE on the schema public"],
      [`GRANT TEMP ON DATABASE "${database}" TO luxia_retention`, `REVOKE TEMP ON DATABASE "${database}" FROM luxia_retention`, "TEMPORARY on the database"],
      [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO luxia_retention`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM luxia_retention`, "is given SELECT on objects created later"],
    ];
    // The attribute and membership branches, on the live role. Both are cluster-wide, so each is undone in a finally;
    // the resources suite runs its files one at a time, so no other suite sees the role in that state.
    seeds.push(
      ["ALTER ROLE luxia_retention BYPASSRLS", "ALTER ROLE luxia_retention NOBYPASSRLS", "bypassrls"],
      ["ALTER ROLE luxia_retention CREATEROLE", "ALTER ROLE luxia_retention NOCREATEROLE", "createrole"],
      ["GRANT pg_read_all_data TO luxia_retention", "REVOKE pg_read_all_data FROM luxia_retention", "member of pg_read_all_data"],
      // Third review: a column privilege, the grant option on an allowed privilege, a setting on the role, and a member.
      [`GRANT SELECT ("id") ON "Subject" TO luxia_retention`, `REVOKE SELECT ("id") ON "Subject" FROM luxia_retention`, "SELECT on the column Subject.id"],
      ["GRANT EXECUTE ON FUNCTION luxia_retention_status() TO luxia_retention WITH GRANT OPTION",
        "REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION luxia_retention_status() FROM luxia_retention", "may grant EXECUTE to others"],
      ["ALTER ROLE luxia_retention SET statement_timeout = '1h'", "ALTER ROLE luxia_retention RESET statement_timeout", "carries the setting statement_timeout"],
      ["GRANT luxia_retention TO app_user", "REVOKE luxia_retention FROM app_user", "has the member app_user"],
    );
    for (const [seed, undo, expected] of seeds) {
      await owner.$executeRawUnsafe(seed);
      try {
        // The code is what the assertion rests on; the detail is read back separately so the reason is named too.
        expect(await validate(), seed).toBe("RETENTION_ROLE_UNSAFE");
        const detail = await owner.$executeRawUnsafe(validation).catch((error: { message?: string }) => String(error.message));
        expect(String(detail), seed).toContain(expected);
      } finally {
        await owner.$executeRawUnsafe(undo);
      }
    }
    expect(await validate()).toBe("OK");
  });

  it("the role cannot grant itself anything, nor reach another role's rights", async () => {
    for (const sql of [`GRANT SELECT ON "Subject" TO luxia_retention`, `ALTER ROLE luxia_retention BYPASSRLS`,
      `SET ROLE app_user`, `CREATE TABLE luxia_retention_probe (id int)`])
      expect(await outcome(retention.$queryRawUnsafe(sql)), sql).not.toBe("OK");
  });
});
