// D8.4 (issue #150): the daily retention job runs as its own database role. This checks the parts a database cannot
// show: that the migration grants the four functions to that role and takes them from app_user, that the activation
// gate does the same in Production and refuses a Production where app_user still holds one, that the job's code has no
// fallback to the application's connection, and that the rollback says what it gives back.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const MIGRATION = "prisma/migrations/20261114120000_retention_worker_role/migration.sql";
const migration = read(MIGRATION);
const rollback = read("docs/operations/RETENTION-WORKER-ROLE-ROLLBACK.sql");
const gate = read(".github/workflows/production-activation-gate.yml");
const bootstrap = read("scripts/ci/bootstrap-app-user.sql");
const purge = read("lib/retention/purge.ts");
const client = read("lib/db/retention-prisma.ts");
const route = read("app/api/internal/retention/route.ts");

const FUNCTIONS = [
  "luxia_retention_purge_transactions(integer, boolean)",
  "luxia_retention_purge_invitations(integer, boolean)",
  "luxia_retention_pseudonymize_retired(integer, boolean)",
  "luxia_retention_status()",
];

describe("D8.4: the retention job's own role", () => {
  it("the migration creates the role without a login, grants it the four functions and takes them from app_user", () => {
    expect(migration).toContain("CREATE ROLE luxia_retention NOLOGIN NOINHERIT;");
    // No password in the code: it is the operator's, set outside any migration. Read with comments stripped, since
    // the migration's own comments say so in words.
    const code = migration.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/PASSWORD/i);
    expect(code).not.toMatch(/LOGIN(?! NOINHERIT)/);
    expect(migration).toContain("GRANT USAGE ON SCHEMA public TO luxia_retention;");
    expect(migration).toContain("GRANT CONNECT ON DATABASE %I TO luxia_retention");
    for (const fn of FUNCTIONS) {
      expect(migration, fn).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO luxia_retention;`);
      expect(migration, fn).toContain(`REVOKE EXECUTE ON FUNCTION ${fn} FROM app_user;`);
    }
    // Nothing else is granted to it: no table, no sequence, no other function.
    const granted = [...code.matchAll(/GRANT ([A-Z, ]+) ON (FUNCTION|SCHEMA|DATABASE|TABLE|SEQUENCE|ALL [A-Z]+)/g)].map((m) => `${m[1].trim()} ${m[2]}`);
    expect([...new Set(granted)].sort()).toEqual(["CONNECT DATABASE", "EXECUTE FUNCTION", "USAGE SCHEMA"]);
  });

  it("the activation gate grants them to that role in Production, and to app_user never", () => {
    const block = /Bootstrap least-privilege runtime grants[\s\S]*?<<'SQL'\n([\s\S]*?)\n\s*SQL\n/.exec(gate)?.[1] ?? "";
    expect(block).not.toBe("");
    for (const fn of ["luxia_retention_purge_transactions(INTEGER,BOOLEAN)", "luxia_retention_purge_invitations(INTEGER,BOOLEAN)",
      "luxia_retention_pseudonymize_retired(INTEGER,BOOLEAN)", "luxia_retention_status()"]) {
      expect(block, fn).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO luxia_retention;`);
      expect(block, fn).toContain(`REVOKE EXECUTE ON FUNCTION public.${fn} FROM app_user;`);
      expect(block, fn).not.toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO app_user;`);
    }
    // The gate never creates the role or sets a password: the migration creates it, the operator gives it one.
    expect(block).not.toMatch(/CREATE ROLE luxia_retention|ALTER ROLE luxia_retention/);
  });

  it("the gate's posture check covers every role app_user can become, not only its own privileges", () => {
    expect(gate).toContain("WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'luxia_retention%'");
    // A membership permits SET ROLE even without inheritance, so the check asks about every reachable role, app_user
    // itself included (Codex F1, review of #196).
    expect(gate).toContain("pg_has_role('app_user', r.oid, 'MEMBER') AND has_function_privilege(r.oid, p.oid, 'EXECUTE')");
    expect(gate).toContain("Runtime role can reach retention functions:");
    expect(gate).not.toContain("has_function_privilege('app_user', p.oid, 'EXECUTE')");
  });

  it("the migration fails closed on a role of that name that is more than the narrow worker", () => {
    expect(migration).toContain("RAISE EXCEPTION 'RETENTION_ROLE_UNSAFE'");
    for (const problem of ["'superuser'", "'bypassrls'", "'createrole'", "'createdb'", "'replication'",
      "'member of ' || r.rolname", "'owns the relation '", "'owns the function '", "'owns the schema '"])
      expect(migration, problem).toContain(problem);
    // Validated whether it was just created or already there: the check sits after the conditional creation.
    expect(migration.indexOf("RETENTION_ROLE_UNSAFE")).toBeGreaterThan(migration.indexOf("CREATE ROLE luxia_retention"));
    // A privilege already granted to it is a capability no attribute names, so the ACLs are read too, and what it may
    // already hold is exactly what this migration grants (Codex F1, second review of #196).
    for (const acl of ["aclexplode(c.relacl)", "aclexplode(p.proacl)", "aclexplode(n.nspacl)", "aclexplode(d.datacl)", "aclexplode(da.defaclacl)"])
      expect(migration, acl).toContain(acl);
    expect(migration).toContain("is given ' || a.privilege_type || ' on objects created later");
    expect(migration).toContain("AND d.datname = current_database() AND a.privilege_type <> 'CONNECT'");
    expect(migration).toContain("NOT (a.privilege_type = 'USAGE' AND n.nspname = 'public')");
  });

  it("CI mirrors it: the role has a test password, and app_user is granted no retention function", () => {
    expect(bootstrap).toContain("CREATE ROLE luxia_retention LOGIN PASSWORD 'retention_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;");
    expect(bootstrap).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.luxia_retention\w*\([^)]*\) TO app_user/);
    const ci = read(".github/workflows/ci.yml");
    expect(ci.match(/LUXIA_RETENTION_DATABASE_URL: postgresql:\/\/luxia_retention:/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("the job has no fallback to the application's connection, and its refusal is a listed code", () => {
    // The job's default connection is its own role's; nothing in the retention path imports the application's client.
    expect(purge).toContain(`import { retentionPrisma } from "@/lib/db/retention-prisma";`);
    expect(purge).not.toContain("raw-prisma");
    expect(purge).toContain("db = retentionPrisma()");
    expect(client).toContain(`if (!url) throw new Error("RETENTION_CONNECTION_NOT_CONFIGURED");`);
    expect(client).not.toContain("rawPrisma");
    expect(read("lib/monitoring/error-reporter.ts")).toContain(`"RETENTION_CONNECTION_NOT_CONFIGURED"`);
    // The route still extracts the code, so the failed-run alert names it rather than the generic one.
    expect(route).toMatch(/RETENTION_\[A-Z0-9_\]\+/);
  });

  it("the rollback gives the four back to app_user, warns what that means, and refuses if it is not the last migration", () => {
    for (const fn of FUNCTIONS) expect(rollback, fn).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO app_user;`);
    expect(rollback).toContain("ROLLBACK_NOT_LATEST_MIGRATION");
    expect(rollback).toContain("R4 and R6 must not be enforcing");
    expect(rollback).toContain(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114120000_retention_worker_role';`);
    // The role itself is kept: dropping it would fail while the Production secret still names it.
    expect(rollback).not.toMatch(/DROP ROLE/);
  });
});
