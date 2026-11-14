// G4, steps 9 to 11 of docs/operations (the restore procedure, private record): once the operator has restored a real
// backup into a DISPOSABLE copy (steps 4 to 7, which hold the key and are the operator's alone), this applies the
// release's migrations to that copy, checks the invariants Production must keep, and writes the drill's report.
//
//   LUXIA_RESTORE_TARGET_URL=<owner of the copy> LUXIA_RESTORE_APP_URL=<app_user of the copy> \
//     node scripts/ops/g4-post-restore.mjs --release <tag or sha> --backup-age-minutes <n> --started <ISO> [--report <file>]
//
// Refuses any target that is not a loopback address, and any database named like Production: this connects to real
// customer data and must never reach the live system. Counts and verdicts only: no row content is read or written, and
// nothing is printed that could identify a person or an organization.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const fail = (message) => { console.error(`REFUSED: ${message}`); process.exit(1); };
const arg = (name) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : undefined; };

const ownerUrl = process.env.LUXIA_RESTORE_TARGET_URL;
const appUrl = process.env.LUXIA_RESTORE_APP_URL;
if (!ownerUrl || !appUrl) fail("set LUXIA_RESTORE_TARGET_URL (owner of the copy) and LUXIA_RESTORE_APP_URL (app_user of the copy)");
const release = arg("release");
if (!release) fail("--release <tag or sha> is required: the report names the release whose migrations were applied");
const backupAge = Number(arg("backup-age-minutes"));
if (!Number.isFinite(backupAge) || backupAge < 0) fail("--backup-age-minutes <n> is required: the backup's age at T0, which is the RPO");
const started = arg("started");
if (!started || Number.isNaN(Date.parse(started))) fail("--started <ISO> is required: T0, the moment the drill began, which gives the RTO");

/** A disposable local copy only. A restored backup holds real data: this must never be able to reach Production. */
for (const [name, value] of [["LUXIA_RESTORE_TARGET_URL", ownerUrl], ["LUXIA_RESTORE_APP_URL", appUrl]]) {
  let url;
  try { url = new URL(value); } catch { fail(`${name} is not a URL`); }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) fail(`${name} points at ${url.hostname}: the drill target must be a disposable copy on this machine`);
  const database = url.pathname.replace(/^\//, "");
  if (!/^[A-Za-z0-9_]+$/.test(database)) fail(`${name} has no plain database name`);
  if (/^neondb/i.test(database)) fail(`${name} names the Production database: refused`);
}

const psql = (url, sql) => {
  const target = new URL(url); target.search = "";
  const result = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), "-c", sql], { encoding: "utf8" });
  if (result.status !== 0) fail(`psql failed: ${(result.stderr || result.error?.message || "").split("\n")[0]}`);
  return result.stdout.replace(/\r/g, "").trim();
};
const readOnly = (url, sql) => psql(url, `BEGIN READ ONLY;\n${sql};\nCOMMIT;`);

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); return ok; };

// Step 9: the release's migrations, as the Production gate applies them.
const migrations = () => readOnly(ownerUrl, `SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
const before = migrations();
const deployStarted = Date.now();
const deploy = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  { encoding: "utf8", env: { ...process.env, DATABASE_URL: ownerUrl } });
const deploySeconds = Math.round((Date.now() - deployStarted) / 1000);
check("migrate deploy", deploy.status === 0, deploy.status === 0 ? `${before} applied before, ${migrations()} after, ${deploySeconds} s`
  : (deploy.stdout + deploy.stderr).split("\n").filter(Boolean).slice(-1)[0] ?? "failed");
if (deploy.status !== 0) { writeFileSync(arg("report") ?? "g4-post-restore-report.json", JSON.stringify({ release, checks }, null, 1)); process.exit(1); }

// Step 10: the invariants Production must keep, on real restored data.
// psql renders a boolean as true/false, so SQL builds the one line this compares: a mismatch in either direction fails.
const runtimeRole = readOnly(appUrl, `SELECT current_user || ' bypassrls=' || r.rolbypassrls || ' superuser=' || r.rolsuper || ' createrole=' || r.rolcreaterole
  FROM pg_roles r WHERE r.rolname = current_user`);
check("runtime role restricted", runtimeRole === "app_user bypassrls=false superuser=false createrole=false", runtimeRole);

// Two tables hold an organization without forced row-level security, by review: Tenant (the scope itself) and
// LegacyUserBridge (the only link to the legacy tables, which R7 refuses to erase). The set must be exactly those two:
// one more would be a table of customer data left open to the runtime role.
const REVIEWED_UNFORCED = "LegacyUserBridge,Tenant";
const unforced = readOnly(ownerUrl, `SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relforcerowsecurity
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organizationId' AND NOT a.attisdropped)`);
check("forced row-level security, outside the reviewed exceptions", unforced === REVIEWED_UNFORCED, `unforced: ${unforced || "none"}`);

const ownerOnly = readOnly(ownerUrl, `SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND c.relforcerowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
    AND EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p WHERE has_table_privilege('app_user', c.oid, p))`);
check("owner-only tables give the runtime role nothing", ownerOnly === "", ownerOnly === "" ? "none" : `reachable: ${ownerOnly}`);

const historyWritable = readOnly(appUrl, `SELECT EXISTS (SELECT 1 FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p
  WHERE has_table_privilege(current_user, 'public._prisma_migrations', p))::text`);
check("migration history read-only for the runtime role", historyWritable === "false", `writable=${historyWritable}`);

const triggers = readOnly(ownerUrl, `SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal`);
check("guard triggers present", Number(triggers) > 0, `${triggers} triggers`);

// The daily job's own entry points, on real restored data: R3's dry run deletes nothing and the status only counts,
// but each records its own run in the copy's RetentionRun table (owner-only, counts only), so neither can sit in a
// read-only transaction. These are the only two statements here that write, and only to the copy step 12 destroys.
const r3 = psql(ownerUrl, `SELECT luxia_retention_purge_transactions(1000, false)::text`);
check("R3 dry run (records its run in the copy)", r3.startsWith("{"), r3);
const status = psql(ownerUrl, `SELECT luxia_retention_status()::text`);
check("retention status (records its run in the copy)", status.startsWith("{"), status);

// How much data came back, per table, with no content: the planner's estimate after the migrations, which ANALYZE
// refreshes. Enough to see that a table came back empty when it should not have, and it reads no row.
const rows = Object.fromEntries(readOnly(ownerUrl, `SELECT string_agg(c.relname || '=' || c.reltuples::bigint, E'\\n' ORDER BY c.relname) FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`).split("\n").filter(Boolean).map((line) => line.split("=")));

const report = {
  kind: "LUXIA_G4_POST_RESTORE_REPORT",
  release,
  target: { host: new URL(ownerUrl).host, database: new URL(ownerUrl).pathname.replace(/^\//, "") },
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
  passed: checks.every((entry) => entry.ok),
};
const path = arg("report") ?? "g4-post-restore-report.json";
writeFileSync(path, JSON.stringify(report, null, 1));
console.log(`\n${report.passed ? "G4 POST-RESTORE PASS" : "G4 POST-RESTORE FAILED"}: RPO ${report.rpoMinutes} min, RTO ${report.rtoMinutes} min. Report: ${path}`);
console.log("Destroy the disposable copy now (step 12), and keep this report in the private evidence store.");
process.exit(report.passed ? 0 : 1);
