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
    // No LOGIN anywhere once NOLOGIN is set aside: the earlier lookahead let "LOGIN NOINHERIT" through (Hydrogen, sixth
    // review of #196).
    expect(code.replace(/\bNOLOGIN\b/gi, "")).not.toMatch(/\bLOGIN\b/i);
    expect(code).toContain("CREATE ROLE luxia_retention NOLOGIN NOINHERIT;");
    expect(migration).toContain("GRANT USAGE ON SCHEMA public TO luxia_retention;");
    expect(migration).toContain("GRANT CONNECT ON DATABASE %I TO luxia_retention");
    for (const fn of FUNCTIONS) {
      expect(migration, fn).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO luxia_retention;`);
      expect(migration, fn).toContain(`REVOKE EXECUTE ON FUNCTION ${fn} FROM app_user;`);
    }
    // Nothing else is granted to it: no table, no sequence, no other function.
    // A reading aid, not the control: every plain GRANT statement outside a string, in any case and with or without
    // ON, must be one of these two kinds; the one inside a string is the database grant checked above (Neon, eighth
    // review of #196). A grant assembled in dynamic SQL, or power given without a GRANT (ownership, a policy), is out
    // of a text test's reach (Claude Opus F-1, ninth review): the catalog validation, re-run by the PostgreSQL suite
    // and by the activation gate, is what refuses them.
    const statements = code.replace(/'[^']*'/g, "''");
    const kinds = [...statements.matchAll(/\bGRANT\b[^;]*/gi)].map((m) => m[0].replace(/\s+/g, " ").trim()).map((g) =>
      /^GRANT EXECUTE ON FUNCTION luxia_retention_\w+\([a-z, ]*\) TO luxia_retention$/.test(g) ? "EXECUTE FUNCTION"
        : g === "GRANT USAGE ON SCHEMA public TO luxia_retention" ? "USAGE SCHEMA" : `UNEXPECTED: ${g}`);
    expect([...new Set(kinds)].sort()).toEqual(["EXECUTE FUNCTION", "USAGE SCHEMA"]);
    expect(kinds.length).toBe(5);
    expect([...code.matchAll(/'GRANT [^']*'/gi)].map((m) => m[0])).toEqual(["'GRANT CONNECT ON DATABASE %I TO luxia_retention'"]);
  });

  it("the activation gate grants them to that role once D8.4 is applied, and to app_user only for a release before it", () => {
    const block = /Bootstrap least-privilege runtime grants[\s\S]*?<<'SQL'\n([\s\S]*?)\n\s*SQL\n/.exec(gate)?.[1]?.replace(/\r/g, "") ?? "";
    expect(block).not.toBe("");
    for (const fn of ["luxia_retention_purge_transactions(integer,boolean)", "luxia_retention_purge_invitations(integer,boolean)",
      "luxia_retention_pseudonymize_retired(integer,boolean)", "luxia_retention_status()"])
      expect(block, fn).toContain(`'public.${fn}'`);
    // Decided by the migration being applied, not by the role existing: its rollback keeps the role, and a release
    // from before D8.4 runs its job as app_user (Gemini 4 Hydrogen F-04). The drill in the PostgreSQL suite runs this
    // very block on a scratch database, before and after the rollback.
    expect(block).toContain("FROM public._prisma_migrations WHERE migration_name = '20261114120000_retention_worker_role'");
    // Without a history, the schema answers: the role holds the four only while D8.4 is applied. The role existing is
    // never enough on its own.
    expect(block).toContain("IF to_regclass('public._prisma_migrations') IS NOT NULL THEN");
    // In a CASE, by the role's oid: AND fixes no order, and a missing role named by text would raise (Neon, eighth review).
    expect(block).toContain("v_d84 := CASE WHEN to_regprocedure('public.luxia_retention_status()') IS NULL");
    expect(block).toMatch(/has_function_privilege\(\(SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention'\),\s+to_regprocedure\('public\.luxia_retention_status\(\)'\), 'EXECUTE'\)/);
    expect(block).not.toContain("has_function_privilege('luxia_retention'");
    // No cast that is resolved at parse time, which would fail on a release without the function.
    expect(block).not.toContain("'public.luxia_retention_status()'::regprocedure");
    expect(block).not.toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'luxia_retention'\) THEN/);
    const decided = block.indexOf("IF v_d84 THEN");
    const otherwise = block.indexOf("ELSE", decided);
    expect(decided).toBeGreaterThan(0);
    expect(block.slice(decided, otherwise)).toContain("GRANT EXECUTE ON FUNCTION %s TO luxia_retention");
    expect(block.slice(decided, otherwise)).toContain("REVOKE EXECUTE ON FUNCTION %s FROM app_user");
    expect(block.slice(decided, otherwise)).not.toContain("TO app_user");
    expect(block.slice(otherwise, block.indexOf("END IF;", otherwise))).toContain("GRANT EXECUTE ON FUNCTION %s TO app_user");
    // The gate never creates the role or sets a password: the migration creates it, the operator gives it one.
    expect(block).not.toMatch(/CREATE ROLE luxia_retention|ALTER ROLE luxia_retention/);
  });

  it("the gate re-checks the worker role at every activation, with the release's own validation block", () => {
    expect(gate).toContain('import { readFileSync } from "node:fs";');
    expect(gate).toContain('readFileSync("prisma/migrations/20261114120000_retention_worker_role/migration.sql", "utf8")');
    expect(gate).toContain("await db.$executeRawUnsafe(validation);");
    expect(gate).toContain('if (!validation.includes("RETENTION_ROLE_UNSAFE")) throw');
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
    for (const problem of ["'superuser'", "'bypassrls'", "'createrole'", "'createdb'", "'replication'", "'inherit'",
      "'member of ' || r.rolname", "'has the member ' || r.rolname", "'carries the setting '"])
      expect(migration, problem).toContain(problem);
    // Validated whether it was just created or already there: the check sits after the conditional creation.
    expect(migration.indexOf("RETENTION_ROLE_UNSAFE")).toBeGreaterThan(migration.indexOf("CREATE ROLE luxia_retention"));
    // Privileges and ownership are read from the cluster's own record of everything that refers to the role, not
    // enumerated by kind, after three reviews each found a kind the list had missed (third review of #196).
    expect(migration).toContain("FROM pg_shdepend d");
    expect(migration).toContain("WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = v_role");
    // The allowed entry points are named by exact signature, so an overload beside them is not admitted.
    for (const signature of ["luxia_retention_purge_transactions(integer, boolean)", "luxia_retention_purge_invitations(integer, boolean)",
      "luxia_retention_pseudonymize_retired(integer, boolean)", "luxia_retention_status()"])
      expect(migration, signature).toContain(`'public.${signature}'::regprocedure::oid`);
    // And no allowed privilege may carry the grant option.
    expect(migration).toContain("may grant EXECUTE on ");
    expect(migration).toContain("(a.privilege_type <> 'CONNECT' OR a.is_grantable)");
    expect(migration).toContain("(a.privilege_type <> 'USAGE' OR a.is_grantable)");
  });

  it("CI mirrors it: the role has a test password, and app_user is granted no retention function", () => {
    expect(bootstrap).toContain("CREATE ROLE luxia_retention LOGIN PASSWORD 'retention_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;");
    expect(bootstrap).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.luxia_retention\w*\([^)]*\) TO app_user/);
    const ci = read(".github/workflows/ci.yml");
    expect(ci.match(/LUXIA_RETENTION_DATABASE_URL: postgresql:\/\/luxia_retention:/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("the operator sets the worker's password by script, as for the backup role: generated, never printed, never typed", () => {
    // Neon refuses a SCRAM verifier, so psql's \password cannot work there (Codex F3, tenth review).
    const script = read("scripts/ops/set-retention-password.mjs");
    expect(script).toContain("randomBytes(32).toString(\"base64url\")");
    expect(script).toContain("ALTER ROLE luxia_retention LOGIN PASSWORD '${password}';");
    expect(script).toContain("{ allowFailure: true }");
    expect(script).toContain("error output withheld");
    expect(script).toContain("writeFileSync(output, url.toString(), { flag: \"wx\", mode: 0o600 });");
    expect(script).toContain("luxia_retention session=luxia_retention superuser=false bypassrls=false inherit=false");
    // The password is never printed: no console line names it, and the only file written is the new one.
    for (const line of script.split("\n").filter((l) => /console\.(log|error)/.test(l))) expect(line).not.toMatch(/password\b(?!\s+set)/i);
    expect(script).not.toContain("process.argv[3]");
    const design = read("docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md");
    expect(design).toContain("scripts/ops/set-retention-password.mjs");
    expect(design).not.toContain("WITH LOGIN PASSWORD '<generated>'");
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
