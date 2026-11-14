// G4, steps 9 to 11 of the restore procedure (private record): once the operator has restored a real backup into a
// DISPOSABLE copy (steps 4 to 7, which hold the backup credential and the private key and are the operator's alone),
// this applies the release's migrations to that copy, checks the invariants Production must keep, and writes the
// drill's report.
//
//   LUXIA_RESTORE_TARGET_URL=<owner of the copy> LUXIA_RESTORE_APP_URL=<app_user of the copy> \
//     node scripts/ops/g4-post-restore.mjs --release <tag or sha> --backup-age-minutes <n> --started <ISO> [--report <file>]
//
// It connects to a copy of real customer data, so it must be unable to reach any other system. Both URLs must be
// postgres on a loopback address, carry no parameter that can redirect a connection, and name a database whose name
// marks it as a restore copy; the whole libpq environment is cleared for every call, so no inherited variable can
// change the target; and the one validated URL is what both psql and Prisma receive (Codex F1, review of #195).
// Counts and verdicts only: no row content is read or printed.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
// What counts as a fault lives in its own module, so a test can drive each decision to its failing answer instead of
// reading it in this source (Codex F5, review of #195).
import { EXPECTED_TRIGGERS, cleanEnvironment, oneTarget, publicAddress, sameServer, triggerFaults, validate } from "./g4-post-restore-checks.mjs";

const fail = (message) => { console.error(`REFUSED: ${message}`); process.exit(1); };
const arg = (name) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : undefined; };

const release = arg("release");
if (!release) fail("--release <tag or sha> is required: the report names the release whose migrations were applied");
const backupAge = Number(arg("backup-age-minutes"));
if (!Number.isFinite(backupAge) || backupAge < 0) fail("--backup-age-minutes <n> is required: the backup's age at T0, which is the RPO");
const started = arg("started");
if (!started || Number.isNaN(Date.parse(started))) fail("--started <ISO> is required: T0, the moment the drill began, which gives the RTO");

const owner = validate("LUXIA_RESTORE_TARGET_URL", process.env.LUXIA_RESTORE_TARGET_URL, fail);
const app = validate("LUXIA_RESTORE_APP_URL", process.env.LUXIA_RESTORE_APP_URL, fail);
// One database on one server: comparing the database name alone let the owner checks run on the restored copy while
// the runtime-role checks ran on a different, clean instance of the same name (Codex F2, review of #195).
const differentTargets = oneTarget(owner, app);
if (differentTargets) fail(differentTargets);

/**
 * The environment every tool runs with: the parent's, minus every libpq variable. PGHOSTADDR, PGHOST, PGSERVICE and
 * the rest would otherwise decide the connection whatever the URL says. The match is case-insensitive, because the
 * Windows runtime reads environment variables without regard to case (Antigravity finding 4, review of #195).
 */
const CLEAN_ENV = cleanEnvironment(process.env);

const psql = (connection, sql) => {
  const result = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", connection, "-c", sql], { encoding: "utf8", env: CLEAN_ENV });
  if (result.status !== 0) fail(`psql failed: ${(result.stderr || result.error?.message || "").split("\n")[0]}`);
  return result.stdout.replace(/\r/g, "").trim();
};
const readOnly = (connection, sql) => psql(connection, `BEGIN READ ONLY;\n${sql};\nCOMMIT;`);

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); return ok; };

// The connection really in use, read back from the server: the report states what was reached, not what was asked for.
// The server's own address is asserted, not merely recorded: a local port forward to another database whose name
// matched would otherwise have passed (Antigravity finding 1, review of #195).
const identity = (connection) => readOnly(connection, `SELECT current_database() || ' on ' || coalesce(inet_server_addr()::text, 'socket') || ':' || coalesce(inet_server_port()::text, 'none')`);
const ownerIdentity = identity(owner.url);
const appIdentity = identity(app.url);
const reached = `${ownerIdentity} as ${readOnly(owner.url, "SELECT current_user")}`;
// What the server answers is its own address for this connection, so a copy in a container answers the container's
// private address, not 127.0.0.1; the check refuses a globally routable one, which is what a managed database behind
// a local tunnel would show. A server on another machine inside the same private network cannot be told apart this
// way: that limit is stated in the report.
const routable = publicAddress(ownerIdentity);
check("the connection reached the disposable copy, not a database beyond this network",
  ownerIdentity.startsWith(`${owner.database} on `) && routable === null, routable ?? reached);
// Both connections must answer the same server, whatever the two URLs say, or the checks below would describe two
// databases: the invariants are read as the owner, the runtime role's rights as app_user.
const elsewhere = sameServer(ownerIdentity, appIdentity);
check("both connections reached the same copy", elsewhere === null, elsewhere ?? appIdentity);

// Step 9: the release's migrations, as the Production gate applies them, through the same validated URL.
const migrations = () => readOnly(owner.url, `SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
const before = migrations();
const deployStarted = Date.now();
const deploy = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  { encoding: "utf8", env: { ...CLEAN_ENV, DATABASE_URL: owner.url } });
const deploySeconds = Math.round((Date.now() - deployStarted) / 1000);
check("migrate deploy", deploy.status === 0, deploy.status === 0 ? `${before} applied before, ${migrations()} after, ${deploySeconds} s`
  : (deploy.stdout + deploy.stderr).split("\n").filter(Boolean).slice(-1)[0] ?? "failed");
if (deploy.status !== 0) { writeFileSync(arg("report") ?? "g4-post-restore-report.json", JSON.stringify({ release, reached, checks }, null, 1)); process.exit(1); }

// Step 10: the invariants Production must keep, on real restored data.
// psql renders a boolean as true/false, so SQL builds the one line each check compares.
const runtimeRole = readOnly(app.url, `SELECT current_user || ' bypassrls=' || r.rolbypassrls || ' superuser=' || r.rolsuper || ' createrole=' || r.rolcreaterole
  FROM pg_roles r WHERE r.rolname = current_user`);
check("runtime role restricted", runtimeRole === "app_user bypassrls=false superuser=false createrole=false", runtimeRole);

// Row-level security must be ENABLED and FORCED: force alone, with it disabled, protects nothing (Codex F2).
// Two tables hold an organization without it, by review: Tenant (the scope itself) and LegacyUserBridge (the only link
// to the legacy tables, which R7 refuses to erase). The set must be exactly those two: one more would be customer data
// left open to the runtime role, one fewer would mean the reviewed exception list no longer matches the schema.
const REVIEWED_UNPROTECTED = "LegacyUserBridge,Tenant";
const unprotected = readOnly(owner.url, `SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organizationId' AND NOT a.attisdropped)`);
check("row-level security enabled and forced, outside the reviewed exceptions", unprotected === REVIEWED_UNPROTECTED, `without both flags: ${unprotected || "none"}`);

// Owner-only tables: every table privilege, and every privilege on the sequences they own, as the activation gate
// reads them (Codex F3). The expected names are checked too, so a table drifting out of the candidate set is caught
// instead of silently leaving the check with nothing to look at.
const EXPECTED_OWNER_ONLY = ["OrganizationErasure", "RateLimitBucket", "RateLimitConfig", "RetentionRun", "SignupCode"];
const ownerOnlyFound = readOnly(owner.url, `SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND c.relforcerowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)`).split(",").filter(Boolean);
const missing = EXPECTED_OWNER_ONLY.filter((name) => !ownerOnlyFound.includes(name));
check("the owner-only tables are all still owner-only", missing.length === 0,
  missing.length === 0 ? `${ownerOnlyFound.length} found, the ${EXPECTED_OWNER_ONLY.length} expected among them` : `no longer owner-only: ${missing.join(", ")}`);

const reachable = readOnly(owner.url, `SELECT coalesce(string_agg(entry, ', ' ORDER BY entry), '') FROM (
    SELECT c.relname || ':' || p AS entry FROM pg_class c
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND c.relforcerowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policy y WHERE y.polrelid = c.oid)
        AND has_table_privilege('app_user', c.oid, p)
    UNION ALL
    SELECT s.relname || ':' || p AS entry FROM pg_class c
      JOIN pg_depend d ON d.refobjid = c.oid AND d.deptype IN ('a', 'i')
      JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
      CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) p
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND c.relforcerowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policy y WHERE y.polrelid = c.oid)
        AND has_sequence_privilege('app_user', s.oid, p)) reachable`);
check("owner-only tables and their sequences give the runtime role nothing", reachable === "", reachable || "nothing");

// ::text, or psql renders the boolean as t or f and the comparison below would never hold.
const historyWritable = readOnly(app.url, `SELECT (EXISTS (SELECT 1 FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p
  WHERE has_table_privilege(current_user, 'public._prisma_migrations', p)))::text`);
check("migration history read-only for the runtime role", historyWritable === "false", `writable=${historyWritable}`);

// Each guard trigger with the table it is attached to, the function it runs, its timing, its level and the operations
// it covers, and the state the catalog reports. The name and the function alone proved nothing: an enabled trigger of
// the same name on another table satisfied the check while the protected table had no guard, and a guard left
// replica-only does not fire for anything an application does (Codex F1 and F3, review of #195). The contract and the
// verdict are in g4-post-restore-checks.mjs, where tests drive them to each failing answer.
const triggerLines = readOnly(owner.url, `SELECT coalesce(string_agg(line, chr(10) ORDER BY line), '') FROM (
  SELECT t.tgname || '|' || c.relname || ' ' || p.proname
    || CASE WHEN (t.tgtype & 2) <> 0 THEN ' BEFORE' ELSE ' AFTER' END
    || CASE WHEN (t.tgtype & 1) <> 0 THEN ' ROW ' ELSE ' STATEMENT ' END
    || array_to_string(ARRAY(SELECT e FROM (VALUES (4, 'INSERT'), (8, 'DELETE'), (16, 'UPDATE'), (32, 'TRUNCATE')) v(b, e)
         WHERE (t.tgtype & v.b) <> 0 ORDER BY e), ',')
    || '|' || t.tgenabled::text AS line
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace) lines`).split("\n").filter(Boolean);
const faults = triggerFaults(triggerLines);
check("the guard triggers are on their own tables and operations, and fire for ordinary writes", faults.length === 0,
  faults.join("; ") || `${Object.keys(EXPECTED_TRIGGERS).length} expected, ${triggerLines.length} present, none disabled or replica-only`);

// The daily job's own entry points, on real restored data: R3's dry run deletes nothing and the status only counts,
// but each records its own run in the copy's RetentionRun table (owner-only, counts only), so neither can sit in a
// read-only transaction. These are the only two statements here that write, and only to the copy step 12 destroys.
const r3 = psql(owner.url, `SELECT luxia_retention_purge_transactions(1000, false)::text`);
check("R3 dry run (records its run in the copy)", r3.startsWith("{"), r3);
const status = psql(owner.url, `SELECT luxia_retention_status()::text`);
check("retention status (records its run in the copy)", status.startsWith("{"), status);

// How much data came back, per table, with no content: the planner's estimate after the migrations. Enough to see that
// a table came back empty when it should not have, and it reads no row.
const rows = Object.fromEntries(readOnly(owner.url, `SELECT coalesce(string_agg(c.relname || '=' || c.reltuples::bigint, chr(10) ORDER BY c.relname), '') FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`).split("\n").filter(Boolean).map((line) => line.split("=")));

const report = {
  kind: "LUXIA_G4_POST_RESTORE_REPORT",
  release,
  target: { database: owner.database, reached },
  rpoMinutes: backupAge,
  rtoMinutes: Math.round((Date.now() - Date.parse(started)) / 60_000),
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date().toISOString(),
  migrateDeploySeconds: deploySeconds,
  migrationsApplied: { before: Number(before), after: Number(migrations()) },
  estimatedRowsPerTable: rows,
  tables: Object.keys(rows).length,
  checks,
  wroteToTheCopy: ["RetentionRun: one row for the R3 dry run, one for the status call"],
  limits: ["The server address is checked against the ranges no database beyond this network can have; a PostgreSQL "
    + "server on another machine inside the same private network would not be distinguished from a local copy."],
  passed: checks.every((entry) => entry.ok),
};
const path = arg("report") ?? "g4-post-restore-report.json";
writeFileSync(path, JSON.stringify(report, null, 1));
console.log(`\n${report.passed ? "G4 POST-RESTORE PASS" : "G4 POST-RESTORE FAILED"}: RPO ${report.rpoMinutes} min, RTO ${report.rtoMinutes} min. Report: ${path}`);
console.log("Destroy the disposable copy now (step 12), and keep this report in the private evidence store.");
process.exit(report.passed ? 0 : 1);
