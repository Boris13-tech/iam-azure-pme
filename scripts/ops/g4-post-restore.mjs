// G4, steps 9 to 11 of the restore procedure (private record): once the operator has restored a real backup into a
// DISPOSABLE copy (steps 4 to 7, which hold the backup credential and the private key and are the operator's alone),
// this applies the release's migrations to that copy, checks the invariants Production must keep, and writes the
// drill's report.
//
//   LUXIA_RESTORE_TARGET_URL=<owner of the copy> LUXIA_RESTORE_APP_URL=<app_user of the copy> \
//     node scripts/ops/g4-post-restore.mjs --release <tag or sha> --backup-age-minutes <n> --started <ISO> [--report <file>]
//     [--production-owner <role>]   (default neondb_owner; run from a clean checkout of the release named)
//
// It connects to a copy of real customer data, so it must be unable to reach any other system. Both URLs must be
// postgres on a loopback address, carry no parameter that can redirect a connection, and name a database whose name
// marks it as a restore copy; the whole libpq environment is cleared for every call, so no inherited variable can
// change the target; and the one validated URL is what both psql and Prisma receive (Codex F1, review of #195).
// Counts and verdicts only: no row content is read or printed.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
// What counts as a fault lives in its own module, so a test can drive each decision to its failing answer instead of
// reading it in this source (Codex F5, review of #195).
import { BACKUP_ROLE_SQL, BEFORE_WRITING_SQL, DEFAULT_PRIVILEGES_SQL, EFFECTIVE_SETTINGS_SQL, EXPECTED_EFFECTIVE_SETTINGS,MIGRATOR_SQL, PARAMETER_GRANTS_SQL, ROLE_SHAPE_SQL, SESSION_SETTINGS_SQL,
  SESSION_TIMEOUTS, migratorFault, runnerExpected,EXPECTED_OWNER_ONLY, EXPECTED_RUNTIME_ROLE, EXPECTED_TRIGGERS, FINGERPRINT_SQL, cleanEnvironment, fingerprintFaults, gateGrantSql,
  gateRevokes, heldRevokedSql, oneTarget, ownerOnlyFault, publicAddress, referenceOf, refusedTarget, sameServer, serverOf, triggerFaults,
  unprotectedFault, validate } from "./g4-post-restore-checks.mjs";

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
// The job's own connection, when the release runs it as a role of its own (D8.4, luxia_retention): optional here,
// required below if the copy has that migration, and held to the same target as the two others.
const job = process.env.LUXIA_RESTORE_RETENTION_URL ? validate("LUXIA_RESTORE_RETENTION_URL", process.env.LUXIA_RESTORE_RETENTION_URL, fail) : null;
if (job) { const elsewhereJob = oneTarget(owner, job); if (elsewhereJob) fail(elsewhereJob); }
// The release named is the one whose files are used: the checked-out commit, with its migrations, its activation gate
// and these scripts unmodified. Otherwise the report would name one release and apply another (Argon finding 4,
// eighth review).
const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
const named = git("rev-parse", "--verify", "--quiet", `${release}^{commit}`).stdout.trim();
const head = git("rev-parse", "HEAD").stdout.trim();
if (!named || named !== head) fail(`--release ${release} is ${named || "not a commit here"}, but the checked-out commit is ${head || "unknown"}: check out the release first`);
const edited = git("status", "--porcelain", "--", "prisma", ".github/workflows/production-activation-gate.yml", "scripts/ops");
if (edited.status !== 0 || edited.stdout.trim()) fail(`the release's files are modified here: ${edited.stdout.trim() || edited.stderr.trim()}`);
// Production's owner, as a backup restored as it is keeps it (neondb_owner unless the operator says otherwise).
const productionOwner = arg("production-owner") ?? "neondb_owner";

/**
 * The environment every tool runs with: the parent's, minus every libpq variable. PGHOSTADDR, PGHOST, PGSERVICE and
 * the rest would otherwise decide the connection whatever the URL says. The match is case-insensitive, because the
 * Windows runtime reads environment variables without regard to case (Antigravity finding 4, review of #195).
 */
const CLEAN_ENV = cleanEnvironment(process.env);

// Throws rather than exits, so a failure inside the reference's block still reaches the finally that drops it
// (Gemini 4 Hydrogen finding 8, seventh review); everywhere else the throw ends the run with the same refusal.
const run = (connection, sql) => {
  const result = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", connection, "-c", sql], { encoding: "utf8", env: CLEAN_ENV });
  if (result.status !== 0) throw new Error(`psql failed: ${(result.stderr || result.error?.message || "").split("\n")[0]}`);
  return result.stdout.replace(/\r/g, "").trim();
};
const psql = (connection, sql) => { try { return run(connection, sql); } catch (error) { return fail(error.message); } };
// Every read pins its search path: a tampered copy cannot shadow what the checks call with objects of its own
// (Gemini 4 Hydrogen finding 5, seventh review).
const readOnly = (connection, sql) => psql(connection, `BEGIN READ ONLY;\nSET LOCAL search_path = pg_catalog, public;\n${sql};\nCOMMIT;`);
const readOnlyOrThrow = (connection, sql) => run(connection, `BEGIN READ ONLY;\nSET LOCAL search_path = pg_catalog, public;\n${sql};\nCOMMIT;`);

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); return ok; };

// The connection really in use, read back from the server: the report states what was reached, not what was asked for.
// The server's own address is asserted, not merely recorded: a local port forward to another database whose name
// matched would otherwise have passed (Antigravity finding 1, review of #195).
const IDENTITY_SQL = `SELECT current_database() || ' on ' || coalesce(inet_server_addr()::text, 'socket') || ':' || coalesce(inet_server_port()::text, 'none')`;
const identity = (connection) => readOnly(connection, IDENTITY_SQL);
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
// If either is wrong, stop here: everything after this applies migrations and writes two rows, and a command whose
// first duty is to touch nothing but the copy must not do that to a target it has just failed to recognise. Recording
// the failure and carrying on to the end would have written to it anyway (Antigravity finding 1, third review of #195).
const targetRefused = refusedTarget(checks);
if (targetRefused) {
  writeFileSync(arg("report") ?? "g4-post-restore-report.json", JSON.stringify({ release, reached, checks, passed: false, stoppedBeforeWriting: true }, null, 1));
  fail(`${targetRefused}; nothing was migrated or written`);
}

// Before anything is written, what would act on the writing itself, or on any session: who owns the schema, the
// settings sessions start with, who may change a protected setting, and anything that fires by itself when step 9
// migrates. All read only; a fault here stops the run before step 9 (Argon findings 1 and 4, Gemini 4 Neon findings 2,
// 4 and 5, eighth review).
const migrator = readOnly(owner.url, MIGRATOR_SQL);
const migratorWrong = migratorFault(migrator, productionOwner);
check("the schema belongs to the role running this or to Production's owner", migratorWrong === null, migratorWrong ?? `owner ${migrator.split(" ")[0]}`);
const unsafeSettings = readOnly(owner.url, SESSION_SETTINGS_SQL);
check("sessions start with no setting beyond timeouts (and the backup role's read only)", unsafeSettings === "",
  unsafeSettings || `only ${SESSION_TIMEOUTS.join(", ")}, if any`);
const effective = `owner: ${readOnly(owner.url, EFFECTIVE_SETTINGS_SQL)}; app_user: ${readOnly(app.url, EFFECTIVE_SETTINGS_SQL)}`;
check("sessions really start with the guards on", effective === `owner: ${EXPECTED_EFFECTIVE_SETTINGS}; app_user: ${EXPECTED_EFFECTIVE_SETTINGS}`, effective);
const parameterGrants = readOnly(owner.url, PARAMETER_GRANTS_SQL);
check("no application role, nor PUBLIC, may change a protected setting", parameterGrants === "", parameterGrants || "none");
const firesOnWrite = readOnly(owner.url, BEFORE_WRITING_SQL);
check("nothing fires by itself when the copy is migrated", firesOnWrite === "", firesOnWrite || "no trigger, rule or policy on the migration history, no event trigger");
const unsafeBeforeWriting = checks.filter((entry) => !entry.ok).map((entry) => entry.name);
if (unsafeBeforeWriting.length > 0) {
  writeFileSync(arg("report") ?? "g4-post-restore-report.json", JSON.stringify({ kind: "LUXIA_G4_POST_RESTORE_REPORT", release, reached, checks,
    passed: false, stoppedBeforeWriting: true }, null, 1));
  fail(`${unsafeBeforeWriting.join("; ")}: nothing was migrated or written`);
}

// Step 9: the release's migrations, as the Production gate applies them, through the same validated URL.
const migrations = () => readOnly(owner.url, `SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
const before = migrations();
// A copy behind the release, owned by another role than the one running this (a Production backup restored as it is,
// owned by Production's owner), cannot be migrated faithfully here: new tables would belong to this role while the
// replaced functions keep their owner, a mix Production never has, and the job then fails on its own tables. That
// combination is refused before anything is migrated; restore a backup taken at the release Production runs, or run
// this as the copy's owner (eighth review of #195).
const applied = new Set(readOnly(owner.url, `SELECT coalesce(string_agg(migration_name, chr(10)), '') FROM "_prisma_migrations"
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`).split("\n").filter(Boolean));
const pending = readdirSync("prisma/migrations").filter((name) => /^\d{14}_/.test(name) && !applied.has(name));
const copyOwner = readOnly(owner.url, `SELECT pg_get_userbyid(relowner) || ' ' || current_user FROM pg_class WHERE oid = 'public._prisma_migrations'::regclass`).split(" ");
if (pending.length > 0 && copyOwner[0] !== copyOwner[1]) {
  writeFileSync(arg("report") ?? "g4-post-restore-report.json", JSON.stringify({ kind: "LUXIA_G4_POST_RESTORE_REPORT", release, reached, checks, passed: false,
    stoppedBeforeWriting: true, refused: `copy behind the release by ${pending.length} migrations and owned by ${copyOwner[0]}, not ${copyOwner[1]}` }, null, 1));
  fail(`the copy is ${pending.length} migrations behind the release and owned by ${copyOwner[0]}, not ${copyOwner[1]}: migrating it here would mix owners `
    + `as Production never does. Restore a backup taken at the release Production runs, or run this as ${copyOwner[0]}. Nothing was migrated or written`);
}
const deployStarted = Date.now();
const migrate = (target) => spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  { encoding: "utf8", env: { ...CLEAN_ENV, DATABASE_URL: target.prismaUrl } });
const deploy = migrate(owner);
const deploySeconds = Math.round((Date.now() - deployStarted) / 1000);
check("migrate deploy", deploy.status === 0, deploy.status === 0 ? `${before} applied before, ${migrations()} after, ${deploySeconds} s`
  : (deploy.stdout + deploy.stderr).split("\n").filter(Boolean).slice(-1)[0] ?? "failed");
if (deploy.status !== 0) {
  writeFileSync(arg("report") ?? "g4-post-restore-report.json", JSON.stringify({ kind: "LUXIA_G4_POST_RESTORE_REPORT", release, reached, checks, passed: false }, null, 1));
  process.exit(1);
}
// A backup older than the release is brought to it as a real recovery would be: its migrations, then the activation
// gate's grant step, which is what gives the objects those migrations created their runtime grants in Production. A
// copy already at the release is left as restored, so its grants are compared as they came back (Argon finding 2,
// eighth review).
const after = migrations();
const gateText = readFileSync(".github/workflows/production-activation-gate.yml", "utf8");
const broughtToRelease = Number(after) > Number(before);
if (broughtToRelease) psql(owner.url, `BEGIN;\n${gateGrantSql(gateText, owner.database)}\nCOMMIT;`);

// Step 10: the invariants Production must keep, on real restored data.
// The copy against a reference: a second disposable database on the same server, migrated from the same release, read
// the same way. It is created and dropped here, and never holds any data (Gemini 4 Hydrogen findings 1, 2 and 5).
const reference = referenceOf(owner, randomBytes(4).toString("hex"));
const server = (sql) => run(owner.url, sql); // CREATE and DROP DATABASE cannot run inside a transaction; throws, see run
const gate = gateText;
let referenceLines = null;
let referenceError = null;
// Only a database this run created is ever dropped: a name that already exists is refused, never cleared first, so
// even a collision cannot take away someone else's database (Codex F5, seventh review).
let created = false;
let referenceDropped = false;
let dropError = null;
try {
  server(`CREATE DATABASE ${reference.database}`);
  created = true;
  // The reference must answer from the copy's own server, like the copy (Gemini 4 Hydrogen finding 8).
  // Its own name too, not only the server: a proxy mapping the name elsewhere would migrate another database (Gemini 4
  // Neon finding 5, eighth review).
  const referenceIdentity = readOnlyOrThrow(reference.url, IDENTITY_SQL);
  if (serverOf(referenceIdentity) !== serverOf(ownerIdentity) || !referenceIdentity.startsWith(`${reference.database} on `)) {
    throw new Error(`the reference answered as ${referenceIdentity}`);
  }
  const migrated = migrate(reference);
  if (migrated.status !== 0) throw new Error((migrated.stdout + migrated.stderr).split("\n").filter(Boolean).slice(-1)[0] ?? "migrate deploy failed");
  // Production's grants are the migrations' and the activation gate's: the reference gets the release's gate grants.
  run(reference.url, `BEGIN;\n${gateGrantSql(gate, reference.database)}\nCOMMIT;`);
  referenceLines = readOnlyOrThrow(reference.url, FINGERPRINT_SQL).split("\n").filter(Boolean);
} catch (error) {
  referenceError = error instanceof Error ? error.message : String(error);
} finally {
  if (created) {
    try { server(`DROP DATABASE ${reference.database} WITH (FORCE)`); referenceDropped = true; } catch (error) { dropError = error instanceof Error ? error.message : String(error); }
  }
}
// A reference left behind is a fault of the run, not a footnote (Gemini 4 Neon finding 5, eighth review).
check("the reference database was dropped", !created || referenceDropped, !created ? "never created" : referenceDropped ? reference.database : `left on the server: ${dropError}`);
const copyLines = readOnly(owner.url, FINGERPRINT_SQL).split("\n").filter(Boolean);
const drift = referenceLines ? fingerprintFaults(copyLines, referenceLines) : [`no reference: ${referenceError}`];
check("schema, grants, policies, triggers and functions are exactly the release's", drift.length === 0,
  drift.length === 0 ? `${copyLines.length} objects, identical to a database migrated from the same release`
    : `${drift.length} differences: ${drift.slice(0, 20).join("; ")}${drift.length > 20 ? "; …" : ""}`);

// psql renders a boolean as true/false, so SQL builds the one line each check compares.
// Also nothing on the database itself beyond connecting: not its owner, no CREATE, nothing granted to it there directly
// (Gemini 4 Neon findings 4 and 6, seventh review). TEMPORARY through PUBLIC is PostgreSQL's default and not counted.
const runtimeRole = readOnly(app.url, ROLE_SHAPE_SQL);
check("runtime role restricted", runtimeRole === EXPECTED_RUNTIME_ROLE, runtimeRole);

// The narrowings the release's activation gate applies to app_user, read from that gate: none may be back on the copy.
const revokes = gateRevokes(gate);
const regranted = readOnly(owner.url, heldRevokedSql(revokes));
check("the activation gate's narrowings of the runtime role all hold", revokes.length > 0 && regranted === "",
  revokes.length === 0 ? "no narrowing found in the release's gate" : regranted ? `held again: ${regranted}` : `${revokes.length} privileges, none held`);

// The backup role is left out of the comparison with the reference, so it is judged here: read only.
const backupBeyondRead = readOnly(owner.url, BACKUP_ROLE_SQL);
check("the backup role can read and do nothing else", backupBeyondRead === "", backupBeyondRead ? `beyond reading: ${backupBeyondRead}` : "read only, or absent");

// Default privileges, judged rather than compared: Production's include rules no reference built from the release has.
const defaultsBeyond = readOnly(owner.url, DEFAULT_PRIVILEGES_SQL);
check("default privileges give the next object nothing beyond the release's grants", defaultsBeyond === "", defaultsBeyond || "app_user's and the backup role's, or none");

// Row-level security must be ENABLED and FORCED: force alone, with it disabled, protects nothing (Codex F2).
// Two tables hold an organization without it, by review: Tenant (the scope itself) and LegacyUserBridge (the only link
// to the legacy tables, which R7 refuses to erase). The set must be exactly those two: one more would be customer data
// left open to the runtime role, one fewer would mean the reviewed exception list no longer matches the schema.
const unprotected = readOnly(owner.url, `SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organizationId' AND NOT a.attisdropped)`);
const rlsFault = unprotectedFault(unprotected);
check("row-level security enabled and forced, outside the reviewed exceptions", rlsFault === null, rlsFault ?? `without both flags: ${unprotected || "none"}`);

// Owner-only tables: every table privilege, and every privilege on the sequences they own, as the activation gate
// reads them (Codex F3). The expected names are checked too, so a table drifting out of the candidate set is caught
// instead of silently leaving the check with nothing to look at.
const ownerOnlyFound = readOnly(owner.url, `SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND c.relforcerowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)`).split(",").filter(Boolean);
const ownerOnlyLost = ownerOnlyFault(ownerOnlyFound);
check("the owner-only tables are all still owner-only", ownerOnlyLost === null,
  ownerOnlyLost ?? `${ownerOnlyFound.length} found, the ${EXPECTED_OWNER_ONLY.length} expected among them`);

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

// The daily job's own entry points, on real restored data, run by the role the job really runs as — not by the owner,
// which would pass whatever the runtime's privileges had become (Argon finding 3 and Gemini 4 Hydrogen finding 2):
// app_user for a release before D8.4, luxia_retention once D8.4 is applied. R3's dry run deletes nothing and the
// status only counts, but each records its own run in the copy's RetentionRun table (owner-only, counts only), so
// neither can sit in a read-only transaction. These are the only two statements here that write, and only to the copy
// step 12 destroys.
const ownRole = readOnly(owner.url, `SELECT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261114120000_retention_worker_role'
  AND finished_at IS NOT NULL AND rolled_back_at IS NULL)::text`) === "true";
const runner = ownRole ? job : app;
// The job's functions run only on a copy that has passed everything above: once a function, a trigger or a grant is
// known to differ from the release, calling the job would run what is possibly tampered code (Codex F4, seventh review).
const failedSoFar = checks.filter((entry) => !entry.ok).map((entry) => entry.name);
let jobRan = false;
if (failedSoFar.length > 0) {
  check("the daily job was not run on a copy that already failed", false, `not run, because of: ${failedSoFar.join("; ")}`);
} else if (!runner) {
  check("the daily job runs on the copy as its own role", false, "D8.4 is applied: set LUXIA_RESTORE_RETENTION_URL to luxia_retention on the copy");
} else {
  // Who that connection really is, and where, before anything is sent through it: the expected role, restricted, on
  // the copy's own server (Argon finding 2, sixth review).
  const expected = ownRole ? "luxia_retention" : "app_user";
  const runnerIdentity = identity(runner.url);
  // The whole role, not three attributes: what it can become and what it owns would widen it as much (Argon finding 4
  // and Gemini 4 Hydrogen finding 6, seventh review).
  // The same query as the runtime role's, database included (Argon finding 3 and Gemini 4 Neon finding 3, eighth review).
  const as = readOnly(runner.url, ROLE_SHAPE_SQL);
  const runnerSettings = readOnly(runner.url, EFFECTIVE_SETTINGS_SQL);
  const runnerOk = as === runnerExpected(expected) && runnerSettings === EXPECTED_EFFECTIVE_SETTINGS && serverOf(runnerIdentity) === serverOf(ownerIdentity)
    && runnerIdentity.startsWith(`${owner.database} on `);
  check(`the daily job's connection is ${expected}, restricted, on the copy`, runnerOk, `${as}, ${runnerSettings}, at ${runnerIdentity}`);
  if (runnerOk) {
    jobRan = true;
    const r3 = psql(runner.url, `SELECT luxia_retention_purge_transactions(1000, false)::text`);
    check(`R3 dry run as ${expected} (records its run in the copy)`, r3.startsWith("{"), r3);
    const status = psql(runner.url, `SELECT luxia_retention_status()::text`);
    check(`retention status as ${expected} (records its run in the copy)`, status.startsWith("{"), status);
  }
}

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
  // What was really written, not what could have been (Gemini 4 Neon finding 5, eighth review).
  migrator: migrator.split(" ")[0],
  wroteToTheCopy: [...(jobRan ? ["RetentionRun: one row for the R3 dry run, one for the status call"] : []),
    ...(broughtToRelease ? [`the release's ${Number(after) - Number(before)} missing migrations, then the activation gate's grant step`] : [])],
  wroteToTheServer: created ? [`${reference.database}: created empty, migrated from the release, given the release's gate grants, read, and `
    + (referenceDropped ? "dropped" : `NOT dropped (${dropError})`)] : [],
  limits: ["What keeps Production out is the loopback URL and a database name that marks a restore copy. The address the "
    + "server answers is checked as a second line only: a server on another machine inside a private network, or a managed "
    + "database behind a tunnel answering a private address, would not be told apart by it.",
    "Scope: G4 shows that the copy is the release, faithfully restored, and that no application role on it holds more than "
    + "the release gives. It does not detect a source database rewritten consistently by someone already holding its owner's "
    + "or a superuser's rights; that is for access control on Production and on the backups.",
    "The backup role's grants are not compared with the reference, which has none: they are judged on their own, read only.",
    "The migration history is compared with checksums: a migration file edited after it was applied in Production shows "
    + "as a difference, which is for the operator to judge."],
  passed: checks.every((entry) => entry.ok),
};
const path = arg("report") ?? "g4-post-restore-report.json";
writeFileSync(path, JSON.stringify(report, null, 1));
console.log(`\n${report.passed ? "G4 POST-RESTORE PASS" : "G4 POST-RESTORE FAILED"}: RPO ${report.rpoMinutes} min, RTO ${report.rtoMinutes} min. Report: ${path}`);
console.log("Destroy the disposable copy now (step 12), and keep this report in the private evidence store.");
process.exit(report.passed ? 0 : 1);
