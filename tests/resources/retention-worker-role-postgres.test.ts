// D8.4 (issue #150), operator decision of 2026-11-14, option A: the daily retention job runs as its own database role.
// On real roles: app_user, which serves every web request, can execute none of the four retention functions;
// luxia_retention can execute exactly those four and nothing else; and it is no more able to enforce R4 or R6 than
// app_user was, since enforcing stays the owner's in its own session.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { rollbacksAfter } from "../helpers/migration-rollbacks";
import { retentionTestClient } from "../helpers/retention-client";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
// Built only when the suite runs: without a database the file must still load, so the others can run.
const owner = enabled ? new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } }) : (undefined as unknown as PrismaClient);
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
    // app_user's own inheritance is restored to what it was, whatever that is (CI's bootstrap and the gate differ).
    const [{ inherited }] = await owner.$queryRaw<Array<{ inherited: boolean }>>`SELECT rolinherit AS inherited FROM pg_roles WHERE rolname = 'app_user'`;
    await owner.$executeRawUnsafe(`ALTER ROLE app_user NOINHERIT`);
    await owner.$executeRawUnsafe(`GRANT luxia_retention TO app_user`);
    try {
      const seen = await reachable();
      expect(seen).toContain("luxia_retention_purge_transactions as luxia_retention");
      expect(seen).toContain("luxia_retention_status as luxia_retention");
      expect(await asAppUserOnly()).toBe("");
      // And the path is real, not only a catalog entry: app_user reaches the function through SET ROLE. One
      // transaction, so both statements share one connection of the pool, and SET LOCAL ends with it.
      const reached = await outcome(rawPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE luxia_retention`);
        return tx.$queryRawUnsafe(`SELECT luxia_retention_status()`);
      }));
      expect(reached).toBe("OK");
    } finally {
      await owner.$executeRawUnsafe(`REVOKE luxia_retention FROM app_user`);
      await owner.$executeRawUnsafe(`ALTER ROLE app_user ${inherited ? "INHERIT" : "NOINHERIT"}`);
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
    // Every seed below was accepted by one of the earlier versions of this validation, as the reviews of #196 showed.
    // Each is [statements that create it, statements that undo it, what the error must name]. The attribute, setting
    // and membership seeds are cluster-wide, so each is undone in a finally; the resources suite runs its files one
    // at a time, so no other suite sees the role in that state.
    const seeds: Array<[string[], string[], string]> = [
      [[`GRANT TRUNCATE ON "RetentionRun" TO luxia_retention`], [`REVOKE TRUNCATE ON "RetentionRun" FROM luxia_retention`], `table "RetentionRun"`],
      [[`GRANT SELECT ON "Subject" TO luxia_retention`], [`REVOKE SELECT ON "Subject" FROM luxia_retention`], `table "Subject"`],
      [[`GRANT SELECT ("id") ON "Subject" TO luxia_retention`], [`REVOKE SELECT ("id") ON "Subject" FROM luxia_retention`], `column id of table "Subject"`],
      [[`GRANT CREATE ON SCHEMA public TO luxia_retention`], [`REVOKE CREATE ON SCHEMA public FROM luxia_retention`], "holds CREATE on the schema public"],
      [[`GRANT TEMP ON DATABASE "${database}" TO luxia_retention`], [`REVOKE TEMP ON DATABASE "${database}" FROM luxia_retention`], `holds TEMPORARY on the database ${database}`],
      [[`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO luxia_retention`],
        [`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM luxia_retention`], "default privileges on new relations"],
      [["GRANT EXECUTE ON FUNCTION luxia_retention_status() TO luxia_retention WITH GRANT OPTION"],
        ["REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION luxia_retention_status() FROM luxia_retention"], "may grant EXECUTE on luxia_retention_status() to others"],
      // Fourth round (Gemini 4 Hydrogen): a catalog function, a type, an overload beside an entry point, a parameter.
      [["GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO luxia_retention"],
        ["REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM luxia_retention"], "function pg_read_file(text)"],
      [[`GRANT USAGE ON TYPE "SubjectType" TO luxia_retention`], [`REVOKE USAGE ON TYPE "SubjectType" FROM luxia_retention`], `type "SubjectType"`],
      [["CREATE FUNCTION public.luxia_retention_status(probe text) RETURNS integer LANGUAGE sql AS 'SELECT 1'",
        "GRANT EXECUTE ON FUNCTION public.luxia_retention_status(text) TO luxia_retention"],
        ["DROP FUNCTION public.luxia_retention_status(text)"], "function luxia_retention_status(text)"],
      [["GRANT SET ON PARAMETER session_replication_role TO luxia_retention"],
        ["REVOKE SET ON PARAMETER session_replication_role FROM luxia_retention"], "parameter session_replication_role"],
      [["ALTER ROLE luxia_retention BYPASSRLS"], ["ALTER ROLE luxia_retention NOBYPASSRLS"], "bypassrls"],
      [["ALTER ROLE luxia_retention CREATEROLE"], ["ALTER ROLE luxia_retention NOCREATEROLE"], "createrole"],
      [["ALTER ROLE luxia_retention INHERIT"], ["ALTER ROLE luxia_retention NOINHERIT"], "inherit"],
      // A setting that silences the guard triggers for every session the worker opens.
      [["ALTER ROLE luxia_retention SET session_replication_role = replica"], ["ALTER ROLE luxia_retention RESET session_replication_role"],
        "carries the setting session_replication_role"],
      [["GRANT pg_read_all_data TO luxia_retention"], ["REVOKE pg_read_all_data FROM luxia_retention"], "member of pg_read_all_data"],
      [["GRANT luxia_retention TO app_user"], ["REVOKE luxia_retention FROM app_user"], "has the member app_user"],
    ];
    for (const [seed, undo, expected] of seeds) {
      for (const statement of seed) await owner.$executeRawUnsafe(statement);
      try {
        // The code is what the assertion rests on; the detail is read back separately so the reason is named too.
        expect(await validate(), seed.join("; ")).toBe("RETENTION_ROLE_UNSAFE");
        const detail = await owner.$executeRawUnsafe(validation).catch((error: { message?: string }) => String(error.message));
        expect(String(detail), seed.join("; ")).toContain(expected);
      } finally {
        for (const statement of undo) await owner.$executeRawUnsafe(statement);
      }
    }
    expect(await validate()).toBe("OK");
    // A timeout only narrows a session, and is how this repository hardens its service roles: accepted (Claude Opus).
    await owner.$executeRawUnsafe(`ALTER ROLE luxia_retention SET statement_timeout = '5min'`);
    try { expect(await validate()).toBe("OK"); } finally { await owner.$executeRawUnsafe(`ALTER ROLE luxia_retention RESET statement_timeout`); }
  }, 120_000); // seventeen seeded states, each applied, validated twice and undone: far past the 5 s default

  it("the role cannot grant itself anything, nor reach another role's rights", async () => {
    for (const sql of [`GRANT SELECT ON "Subject" TO luxia_retention`, `ALTER ROLE luxia_retention BYPASSRLS`,
      `SET ROLE app_user`, `CREATE TABLE luxia_retention_probe (id int)`])
      expect(await outcome(retention.$queryRawUnsafe(sql)), sql).not.toBe("OK");
  });

  // Claude Opus F2 and Gemini 4 Hydrogen F5, fourth review of #196: another database of the cluster cannot be read
  // from here, but a built-in such as pg_read_file has the same id everywhere, and more than the four functions is
  // more than the worker needs. Both are refused from this database.
  it("the validation refuses, from here, a built-in or a fifth function granted in another database", async () => {
    const migration = readFileSync("prisma/migrations/20261114120000_retention_worker_role/migration.sql", "utf8");
    const from = migration.indexOf("DO $$");
    const validation = migration.slice(from, migration.indexOf("END $$;", from) + "END $$;".length);
    const admin = new URL(process.env.DATABASE_MIGRATION_URL!); admin.search = "";
    const name = `luxia_d84o_${randomUUID().slice(0, 8)}`;
    const run = (url: string, sql: string) => {
      const result = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
    };
    run(admin.toString(), `CREATE DATABASE ${name}`);
    const other = new URL(admin.toString()); other.pathname = `/${name}`;
    try {
      run(other.toString(), "GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO luxia_retention");
      const builtIn = await owner.$executeRawUnsafe(validation).then(() => "OK", (error: { message?: string }) => String(error.message));
      expect(builtIn).toContain("RETENTION_ROLE_UNSAFE");
      expect(builtIn).toContain("holds a privilege on pg_proc in another database");
      run(other.toString(), "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM luxia_retention");
      // Five functions created there and granted: one more than the worker's four.
      for (let i = 1; i <= 5; i++) {
        run(other.toString(), `CREATE FUNCTION public.probe_${i}() RETURNS integer LANGUAGE sql AS 'SELECT ${i}'`);
        run(other.toString(), `GRANT EXECUTE ON FUNCTION public.probe_${i}() TO luxia_retention`);
      }
      const five = await owner.$executeRawUnsafe(validation).then(() => "OK", (error: { message?: string }) => String(error.message));
      expect(five).toContain("holds a privilege on 5 functions in another database");
      run(other.toString(), "DROP FUNCTION public.probe_5()");
      expect(await owner.$executeRawUnsafe(validation).then(() => "OK", (error: { message?: string }) => String(error.message))).toBe("OK");
    } finally {
      spawnSync("psql", ["-X", "-q", admin.toString(), "-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`], { encoding: "utf8" });
    }
  }, 120_000);

  // Gemini 4 Hydrogen F-04 and F-05, third review of #196. A drill with Prisma's real history on a scratch database:
  // the rollback gives the four functions back to app_user and keeps the role; the activation gate's own grant block,
  // run on a release from before D8.4, must leave them with app_user (it used to revoke them because the role
  // existed); and migrate deploy, then the gate again, bring the separation back.
  it("drill: rollback, the gate on a release from before D8.4, then migrate deploy and the gate again", () => {
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
    // The gate's grant block, exactly as the workflow holds it.
    const workflow = readFileSync(".github/workflows/production-activation-gate.yml", "utf8").replace(/\r/g, "");
    const at = workflow.indexOf("v_d84 boolean");
    const start = workflow.lastIndexOf("DO $$", at);
    const gateBlock = workflow.slice(start, workflow.indexOf("END $$;", at) + "END $$;".length);
    expect(gateBlock).toContain("GRANT EXECUTE ON FUNCTION %s TO app_user");
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_d84_${randomUUID().slice(0, 8)}`;
    psql(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    // How many of the four each role can execute, and whether the history records D8.4.
    const state = () => psql(url, ["-c", `SELECT
        (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'luxia_retention%'
           AND has_function_privilege('app_user', p.oid, 'EXECUTE'))
        || ' ' || (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'luxia_retention%'
           AND has_function_privilege('luxia_retention', p.oid, 'EXECUTE'))
        || ' ' || (SELECT count(*) FROM "_prisma_migrations" WHERE "migration_name" = '20261114120000_retention_worker_role'
           AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL)`]);
    const gate = () => psql(url, ["-1", "-c", gateBlock]);
    try {
      deploy(url);
      expect(state(), "after deploy: app_user none, the role four, D8.4 recorded").toBe("0 4 1");
      for (const script of rollbacksAfter("20261114120000_retention_worker_role")) psql(url, ["-1", "-f", script]);
      psql(url, ["-1", "-f", "docs/operations/RETENTION-WORKER-ROLE-ROLLBACK.sql"]);
      expect(state(), "after the rollback: back on app_user, the role kept but empty").toBe("4 0 0");
      // Kept. Its login is disabled only when no other database of the cluster refers to it: here the suite's own
      // database does, so it keeps it, and the other suites still connect (the single-database case, Production's, is
      // the production-owner drill's: there the login goes).
      const elsewhere = psql(url, ["-c", `SELECT EXISTS (SELECT 1 FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass
        AND d.refobjid = 'luxia_retention'::regrole AND d.dbid <> (SELECT oid FROM pg_database WHERE datname = current_database())
        AND NOT (d.dbid = 0 AND d.classid = 'pg_database'::regclass AND d.objid = (SELECT oid FROM pg_database WHERE datname = current_database())))::text`]);
      expect(elsewhere).toBe("true");
      expect(psql(admin, ["-c", "SELECT count(*) || ' ' || bool_or(rolcanlogin)::text FROM pg_roles WHERE rolname = 'luxia_retention'"])).toBe("1 true");
      gate();
      expect(state(), "the gate on a release from before D8.4 leaves them with app_user").toBe("4 0 0");
      // Before D8.4 comes back, its login is enabled again, as the operator does in Neon.
      psql(admin, ["-c", "ALTER ROLE luxia_retention LOGIN"]);
      deploy(url);
      expect(state(), "migrate deploy applies D8.4 again, its validation accepting the kept role").toBe("0 4 1");
      gate();
      expect(state(), "and the gate keeps the separation").toBe("0 4 1");
    } finally {
      const target = new URL(admin); target.search = "";
      // The role is the cluster's: whatever happened above, the other suites need it able to log in.
      spawnSync("psql", ["-X", "-q", target.toString(), "-c", "ALTER ROLE luxia_retention LOGIN"], { encoding: "utf8" });
      spawnSync("psql", ["-X", "-q", target.toString(), "-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`], { encoding: "utf8" });
    }
  }, 240_000);
});
