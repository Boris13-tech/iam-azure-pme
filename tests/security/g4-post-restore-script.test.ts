// G4: scripts/ops/g4-post-restore.mjs runs against a copy restored from a real backup, so its first duty is to be
// unable to reach anything else. These tests check every refusal without a database: a refused run must stop before it
// calls psql at all. They also pin the controls the reviewers of #195 asked for: the connection cannot be redirected
// by a URL parameter or by an inherited libpq variable, and the invariants read both row-level security flags, the
// sequences of owner-only tables, and each guard trigger by name and enabled state.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "g4-post-"));
const calls = join(dir, "calls.log");
const env = join(dir, "env.log");
// A psql that records every call and the whole environment it was given, and refuses nothing: a refusal must come from
// the script, never from the database. `env` is named by absolute path, because these runs put only this directory on
// PATH: a bare `env | grep` could not be found, its failure was swallowed by `|| true`, and the empty log then "proved"
// that no libpq variable had been passed (Codex F4, review of #195). The probe variable makes the recorder's own
// silence impossible to mistake for a clean environment.
writeFileSync(join(dir, "psql"), `#!/bin/sh
echo "$*" >> "${calls.replace(/\\/g, "/")}"
/usr/bin/env >> "${env.replace(/\\/g, "/")}" 2>/dev/null || true
echo stub
`);
chmodSync(join(dir, "psql"), 0o755);
// A stand-in git too, since the runs see this directory alone: the checked-out commit is aaaa…, the release named
// "rc-private-beta-1" or "HEAD" resolves to it and any other name to another commit; LUXIA_G4_STUB_DIRTY makes the
// release's files look modified. The script refuses both before connecting (Argon finding 4, eighth review).
writeFileSync(join(dir, "git"), `#!/bin/sh
case "$*" in
  "rev-parse HEAD") echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  "rev-parse --verify --quiet HEAD^{commit}"|"rev-parse --verify --quiet rc-private-beta-1^{commit}") echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  "rev-parse --verify --quiet"*) echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
  "status --porcelain -- prisma .github/workflows/production-activation-gate.yml scripts/ops")
    [ -n "$LUXIA_G4_STUB_DIRTY" ] && echo " M prisma/schema.prisma" ;;
  status*) echo "unexpected status paths: $*" ; exit 2 ;;
esac
exit 0
`);
chmodSync(join(dir, "git"), 0o755);
// The shebang is /bin/sh, not /usr/bin/env: the runs below see this directory alone, so env could not find bash.
// A spawned command is resolved without a shell, so a file named `psql` with a shebang is reachable on Linux, where
// CI runs, but not on Windows. Where it is unreachable, "it called no database" would hold for the wrong reason, so
// the checks that need the stub are skipped there, and CI asserts that it is reachable.
const stubReachable = spawnSync("psql", ["--version"], { encoding: "utf8", env: { ...process.env, PATH: dir } }).stdout?.includes("stub") === true;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LOCAL = "postgresql://restore_owner:p@127.0.0.1:15560/luxia_restore_rc";
const LOCAL_APP = "postgresql://app_user:p@127.0.0.1:15560/luxia_restore_rc";
// The report goes to the test's own directory, never into the repository (Gemini 4 Hydrogen finding 8).
const OK_ARGS = ["--release", "rc-private-beta-1", "--backup-age-minutes", "42", "--started", new Date().toISOString(),
  "--report", join(dir, "report.json")];
// Line endings normalised, so a Windows checkout reads the same source as CI (Gemini 4 Neon finding 7, ninth review).
const source = readFileSync("scripts/ops/g4-post-restore.mjs", "utf8").replace(/\r/g, "");

/** A variable the stand-in must report back, so an empty recording is read as a broken recorder, not as a clean run. */
const PROBE = "LUXIA_G4_STUB_PROBE";

function run(args: string[], overrides: Record<string, string | undefined> = {}) {
  writeFileSync(calls, "");
  writeFileSync(env, "");
  const result = spawnSync(process.execPath, ["scripts/ops/g4-post-restore.mjs", ...args], { encoding: "utf8",
    env: { ...process.env, LUXIA_RESTORE_TARGET_URL: LOCAL, LUXIA_RESTORE_APP_URL: LOCAL_APP, PATH: dir, [PROBE]: "recorded", ...overrides } });
  const recorded = readFileSync(env, "utf8").replace(/\r/g, "").split("\n").filter(Boolean);
  return { code: result.status, out: `${result.stdout}${result.stderr}`.replace(/\r/g, ""),
    calls: readFileSync(calls, "utf8"), recorded, pgEnv: recorded.filter((entry) => /^PG/i.test(entry)).join("\n") };
}

describe("G4 post-restore script: it can reach nothing but a disposable local copy", () => {
  it.runIf(process.env.CI)("in CI the stand-in psql is reachable, so the assertions below mean what they say", () => {
    expect(stubReachable).toBe(true);
  });

  it.runIf(stubReachable)("refuses a release that is not the checked-out commit, or whose files are modified, before connecting", () => {
    const other = run(["--release", "rc-private-beta-0", ...OK_ARGS.slice(2)]);
    expect(other.code).toBe(1);
    expect(other.out).toContain("REFUSED: --release rc-private-beta-0 is bbbbbbbb");
    expect(other.out).toContain("check out the release first");
    expect(other.calls).toBe("");
    const dirty = run(OK_ARGS, { LUXIA_G4_STUB_DIRTY: "1" });
    expect(dirty.code).toBe(1);
    expect(dirty.out).toContain("REFUSED: the release's files are modified here: M prisma/schema.prisma");
    expect(dirty.calls).toBe("");
  });

  it("the recovery runbook brings an older backup to the release before G4, which never migrates a copy itself", () => {
    // Operator decision, 2026-11-20: the upgrade is an explicit recovery step, run before the verification.
    const runbook = readFileSync("docs/operations/BACKUP-RUNBOOK.md", "utf8").replace(/\r/g, "");
    const step = runbook.slice(runbook.indexOf("6. **Bring the database to the deployed release, then verify a copy of it (G4).**"), runbook.indexOf("7. **Recreate the backup role**"));
    expect(step.length).toBeGreaterThan(200);
    expect(step).toContain("The G4 command never migrates anything itself");
    // The target and the verified copy are told apart, and the copy is brought up as its own owner (Gemini 4 Hydrogen
    // finding 2 and Neon finding 3, eleventh review).
    expect(step).toContain("G4 runs on a disposable local copy, never on the target itself");
    expect(step).toContain("as the same owner role");
    expect(step).toContain("--production-owner <the target's owner>");
    expect(step).toContain("npx prisma migrate deploy");
    expect(step).toContain("Bootstrap least-privilege runtime grants");
    expect(step).toContain("node scripts/ops/g4-post-restore.mjs --release");
    expect(step).toContain("do not switch the application");
    expect(runbook.indexOf("6. **Bring the database")).toBeLessThan(runbook.indexOf("8. **Switch the application:**"));
  });

  it("refuses a target that is not loopback, before touching any database", () => {
    for (const host of ["ep-cool-forest-123.eu-central-1.aws.neon.tech", "10.0.0.5", "db.example.com"]) {
      for (const which of ["LUXIA_RESTORE_TARGET_URL", "LUXIA_RESTORE_APP_URL"]) {
        const { code, out, calls: made } = run(OK_ARGS, { [which]: `postgresql://u:p@${host}:5432/luxia_restore_rc` });
        expect(code, `${which} ${host}`).toBe(1);
        expect(out, `${which} ${host}`).toContain(`REFUSED: ${which} points at ${host}`);
        expect(made, `${which} ${host}`).toBe("");
      }
    }
  });

  it("refuses any database whose name does not mark it a restore copy, Production's included", () => {
    // Every name in the list is exercised: the list itself is the evidence (Gemini 4 Hydrogen finding 5).
    for (const database of ["neondb", "NEONDB", "neondb_prod", "luxia_db", "postgres", "luxia_restor"]) {
      const { code, out, calls: made } = run(OK_ARGS, { LUXIA_RESTORE_TARGET_URL: `postgresql://u:p@127.0.0.1:15560/${database}` });
      expect(code, database).toBe(1);
      expect(out, database).toContain(`names the database ${database}: the drill target must be named luxia_restore`);
      expect(made, database).toBe("");
    }
    // The two URLs must name the same copy: one validated name, not two.
    const mixed = run(OK_ARGS, { LUXIA_RESTORE_APP_URL: "postgresql://app_user:p@127.0.0.1:15560/luxia_restore_other" });
    expect(mixed.code).toBe(1);
    expect(mixed.out).toContain("the two URLs name different databases");
    expect(mixed.calls).toBe("");
  });

  // Codex F1, review of #195: the hostname in the URL does not decide the connection on its own.
  it("refuses a URL parameter that could send the connection elsewhere, and any scheme but postgres", () => {
    for (const parameter of ["host=/tmp", "hostaddr=10.0.0.5", "options=-c%20search_path%3Devil", "service=production", "target_session_attrs=any"]) {
      const { code, out, calls: made } = run(OK_ARGS, { LUXIA_RESTORE_TARGET_URL: `${LOCAL}?${parameter}` });
      expect(code, parameter).toBe(1);
      expect(out, parameter).toContain(`carries the parameter ${parameter.split("=")[0]}, which could send the connection elsewhere`);
      expect(made, parameter).toBe("");
    }
    // The parameters a connection legitimately needs are allowed: it gets as far as calling the database.
    if (stubReachable) expect(run(OK_ARGS, { LUXIA_RESTORE_TARGET_URL: `${LOCAL}?sslmode=disable&schema=public` }).calls).not.toBe("");
    for (const scheme of ["mysql", "http"]) {
      const { code, out } = run(OK_ARGS, { LUXIA_RESTORE_TARGET_URL: `${scheme}://u:p@127.0.0.1:15560/luxia_restore_rc` });
      expect(code, scheme).toBe(1);
      expect(out, scheme).toContain(`is not a postgres URL (${scheme}:)`);
    }
    // A file URL carrying credentials does not parse at all, so it is refused one step earlier; either way it stops.
    const asFile = run(OK_ARGS, { LUXIA_RESTORE_TARGET_URL: "file://u:p@127.0.0.1:15560/luxia_restore_rc" });
    expect(asFile.code).toBe(1);
    expect(asFile.out).toMatch(/REFUSED: LUXIA_RESTORE_TARGET_URL is not (a URL|a postgres URL)/);
  });

  // Antigravity, fourth review of #195: the stop before writing was shown live once, then pinned only by source order.
  // The stand-in answers every query with "stub", so the server reports no address and the target is not established:
  // the run must stop there, through the real process, having sent nothing but read-only queries.
  it.runIf(stubReachable)("a target that is not established stops the run before any migration or write", () => {
    const { code, out, calls: made } = run(OK_ARGS);
    expect(code).toBe(1);
    expect(out).toContain("REFUSED: the target is not established");
    expect(out).toContain("nothing was migrated or written");
    expect(out).not.toContain("migrate deploy");
    // One call per "-X" (the first argument the script gives psql); a call's SQL spans several lines.
    const statements = made.replace(/\r/g, "").split(/^(?=-X )/m).filter((call) => call.trim());
    expect(statements.length).toBeGreaterThan(0);                       // it did reach the stand-in
    for (const statement of statements) expect(statement, statement).toContain("BEGIN READ ONLY");
    expect(made).not.toContain("luxia_retention_purge_transactions");
    expect(made).not.toContain("luxia_retention_status");
  });

  it.runIf(stubReachable)("clears every inherited libpq variable, so none can decide the target", () => {
    const { pgEnv, recorded, calls: made } = run(OK_ARGS, { PGHOSTADDR: "10.0.0.5", PGHOST: "db.example.com", PGPORT: "5432",
      PGUSER: "postgres", PGPASSWORD: "x", PGDATABASE: "neondb", PGSERVICE: "production", PGOPTIONS: "-c x=y", pghostaddr: "10.0.0.6" });
    expect(made).not.toBe("");          // it did call psql
    // The recorder works: a variable that is not libpq's came through. Without this, an empty log would prove nothing.
    expect(recorded).toContain(`${PROBE}=recorded`);
    expect(pgEnv).toBe("");              // and psql saw no PG variable at all, in any case
    // Both tools are given the same cleaned environment, and the same validated URL.
    expect(source).toContain("const CLEAN_ENV = cleanEnvironment(process.env);");
    expect(source).toContain("{ encoding: \"utf8\", env: CLEAN_ENV }");
    // Prisma gets the same validated target, its schema pinned to public; only the reference is migrated, never the
    // copy, whose restored code is unverified until compared (Codex F1, ninth review).
    expect(source).toContain("env: { ...CLEAN_ENV, DATABASE_URL: target.prismaUrl }");
    expect(source).toContain("const migrated = migrate(reference);");
    expect(source).not.toMatch(/migrate\(owner\)/);
    expect([...source.matchAll(/\bmigrate\((\w+)\)/g)].map((m) => m[1])).toEqual(["reference"]);
  });

  it("refuses a missing or malformed URL, or a database name that is not plain", () => {
    expect(run(OK_ARGS, { LUXIA_RESTORE_TARGET_URL: undefined }).out).toContain("REFUSED: set LUXIA_RESTORE_TARGET_URL");
    expect(run(OK_ARGS, { LUXIA_RESTORE_APP_URL: undefined }).out).toContain("REFUSED: set LUXIA_RESTORE_APP_URL");
    expect(run(OK_ARGS, { LUXIA_RESTORE_TARGET_URL: "not a url" }).out).toContain("REFUSED: LUXIA_RESTORE_TARGET_URL is not a URL");
    const odd = run(OK_ARGS, { LUXIA_RESTORE_TARGET_URL: "postgresql://u:p@127.0.0.1:15560/luxia restore" });
    expect(odd.code).toBe(1);
    expect(odd.out).toContain("has no plain database name");
  });

  it("refuses without the evidence the report needs: the release, the backup's age and T0", () => {
    const cases: Array<[string[], string]> = [
      [["--backup-age-minutes", "42", "--started", new Date().toISOString()], "--release <tag or sha> is required"],
      [["--release", "rc", "--started", new Date().toISOString()], "--backup-age-minutes <n> is required"],
      [["--release", "rc", "--backup-age-minutes", "-1", "--started", new Date().toISOString()], "--backup-age-minutes <n> is required"],
      [["--release", "rc", "--backup-age-minutes", "x", "--started", new Date().toISOString()], "--backup-age-minutes <n> is required"],
      [["--release", "rc", "--backup-age-minutes", "42"], "--started <ISO> is required"],
      [["--release", "rc", "--backup-age-minutes", "42", "--started", "yesterday"], "--started <ISO> is required"],
    ];
    for (const [args, message] of cases) {
      const { code, out, calls: made } = run(args);
      expect(code, message).toBe(1);
      expect(out, message).toContain(`REFUSED: ${message}`);
      expect(made, message).toBe("");
    }
  });

  it("every statement it sends is read-only, except the two it names in the report", () => {
    // One call site wraps everything in BEGIN READ ONLY; the migrations go through Prisma. A third direct call would
    // change this list and has to be reviewed.
    expect(source).toMatch(/const readOnly = \(connection, sql\) => psql\(connection, `BEGIN READ ONLY;/);
    // On the copy, only the job's two entry points, run by the job's own role (runner), never by the owner.
    const direct = [...source.matchAll(/const \w+ = psql\(runner\.url, `([^`]+)`\)/g)].map((m) => m[1].trim());
    expect(source).not.toMatch(/psql\(owner\.url, `SELECT luxia_retention/);
    // And on the reference, only the release's gate grants, in one transaction.
    expect([...source.matchAll(/run\(reference\.url, `([^`]+)`\)/g)].map((m) => m[1])).toEqual(["BEGIN;\\n${gateGrantSql(gate, reference.database)}\\nCOMMIT;"]);
    // Inside the reference's block every call throws rather than exits, so the finally that drops it always runs.
    expect(source).toContain("const server = (sql) => run(owner.url, sql);");
    expect(source).toContain("readOnlyOrThrow(reference.url, FINGERPRINT_SQL)");
    // Every read pins its search path.
    expect(source).toContain("SET LOCAL search_path = pg_catalog, pg_temp;");
    expect(direct).toEqual([
      "SELECT luxia_retention_purge_transactions(1000, false)::text",
      "SELECT luxia_retention_status()::text",
    ]);
    expect(source).toContain("wroteToTheCopy");
    // The only statements sent to the server outside a transaction: the reference database, created, then dropped only
    // if this run created it — never cleared beforehand, so a name collision cannot drop someone else's (Codex F5).
    const toServer = [...source.matchAll(/server\(`([^`]+)`\)/g)].map((m) => m[1]);
    expect(toServer).toEqual([
      "CREATE DATABASE ${reference.database} TEMPLATE template0",
      "DROP DATABASE ${reference.database} WITH (FORCE)",
    ]);
    expect(source).toContain("if (created) {\n    try { server(`DROP DATABASE");
    expect(source).not.toContain("DROP DATABASE IF EXISTS");
    // Every direct call to the database, whatever its target or form: the pattern-based lists above missed a new write
    // to the copy (Gemini 4 Neon finding 6, eighth review). Any added call changes this list and has to be reviewed.
    const calls = [...source.replace(/\r/g, "").matchAll(/\b(psql|run|server)\(([^\n]{0,90})/g)].map((m) => `${m[1]}(${m[2]}`.slice(0, 60));
    expect(calls).toEqual([
      "run(connection, sql); } catch (error) { return fail(error.me", // psql: run, exiting on failure
      "psql(connection, `BEGIN READ ONLY;\\nSET LOCAL search_path = ", // readOnly
      "run(connection, `BEGIN READ ONLY;\\nSET LOCAL search_path = p", // readOnlyOrThrow
      "psql(connection, `BEGIN READ ONLY;\\n${sql};\\nCOMMIT;`);", // readSessionStart: read only, nothing pinned
      "run(owner.url, sql); // CREATE and DROP DATABASE cannot run ", // server
      "server(`CREATE DATABASE ${reference.database} TEMPLATE templ",
      "run(reference.url, `BEGIN;\\n${gateGrantSql(gate, reference.d",
      "server(`DROP DATABASE ${reference.database} WITH (FORCE)`); ",
      "psql(runner.url, `SELECT luxia_retention_purge_transactions(",
      "psql(runner.url, `SELECT luxia_retention_status()::text`);",
    ]);
    // Both read helpers pin the search path, each on its own.
    expect(source).toContain("const readOnly = (connection, sql) => psql(connection, `BEGIN READ ONLY;\\nSET LOCAL search_path = pg_catalog, pg_temp;\\n${sql};\\nCOMMIT;`);");
    expect(source).toContain("const readOnlyOrThrow = (connection, sql) => run(connection, `BEGIN READ ONLY;\\nSET LOCAL search_path = pg_catalog, pg_temp;\\n${sql};\\nCOMMIT;`);");
    // The two job calls sit in the branch that runs only when nothing failed before them.
    const guard = source.indexOf("if (failedSoFar.length > 0) {\n  check(\"the daily job was not run on a copy that already failed\", false");
    expect(guard).toBeGreaterThan(0);
    expect(source.indexOf("} else if (!runner) {", guard)).toBeLessThan(source.indexOf("luxia_retention_purge_transactions(1000, false)"));
    // The checks that read what would act on the writing come before step 9, and stop the run when one fails.
    const beforeWriting = source.indexOf("const unsafeBeforeWriting = checks.filter((entry) => !entry.ok)");
    expect(beforeWriting).toBeGreaterThan(source.indexOf("readOnly(owner.url, BEFORE_WRITING_SQL)"));
    expect(beforeWriting).toBeLessThan(source.indexOf("const migrated = migrate(reference)"));
    // A copy not at the release stops the run before the reference is created or anything is written.
    const notAtRelease = source.indexOf("if (pending.length > 0 || foreign.length > 0) {");
    expect(notAtRelease).toBeGreaterThan(beforeWriting);
    expect(notAtRelease).toBeLessThan(source.indexOf("server(`CREATE DATABASE"));
    // The job's functions run only on a copy that has passed every check before them (Codex F4).
    const gateOnFailures = source.indexOf("const failedSoFar = checks.filter((entry) => !entry.ok)");
    expect(gateOnFailures).toBeGreaterThan(0);
    expect(gateOnFailures).toBeLessThan(source.indexOf("luxia_retention_purge_transactions(1000, false)"));
    expect(source).toContain("wroteToTheServer");
    const sent = [...source.matchAll(/readOnly\([^,]+,\s*`\s*([A-Za-z]+)/g)].map((m) => m[1].toUpperCase());
    expect(sent.length).toBeGreaterThanOrEqual(8);
    expect([...new Set(sent)]).toEqual(["SELECT"]);
    for (const forbidden of [/\bDELETE FROM\b/, /\bTRUNCATE "/, /\bUPDATE "\w+" SET/, /\bINSERT INTO\b/, /\bALTER (TABLE|ROLE)\b/,
      /luxia_retention_purge_\w+\([^)]*true/, /luxia_retention_pseudonymize_\w+\([^)]*true/, /luxia_organization_erase/, /luxia_retention_hold_(place|renew|release)/])
      expect(source, String(forbidden)).not.toMatch(forbidden);
  });

  // Codex F2, F3 and F4, review of #195: a check that is too narrow reports PASS while the invariant is broken.
  it("the invariants are read the way the activation gate reads them", () => {
    // Row-level security: both flags, not FORCE alone.
    expect(source).toContain("NOT (c.relrowsecurity AND c.relforcerowsecurity)");
    expect(source).not.toMatch(/NOT c\.relforcerowsecurity\b/);
    // Owner-only: every table privilege, and the sequences those tables own.
    expect(source).toContain("unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])");
    expect(source).toContain("unnest(ARRAY['USAGE','SELECT','UPDATE'])");
    expect(source).toContain("has_sequence_privilege('app_user', s.oid, p)");
    // The verdicts on what was read come from the checks module, whose tests drive each to its failing answer.
    expect(source).toContain("const ownerOnlyLost = ownerOnlyFault(ownerOnlyFound);");
    expect(source).toContain("const rlsFault = unprotectedFault(unprotected);");
    expect(source).toContain("runtimeRole === EXPECTED_RUNTIME_ROLE");
    // And a target that was not established stops the run before the migrations and the two writes.
    const stop = source.indexOf("const targetRefused = refusedTarget(checks);");
    expect(stop).toBeGreaterThan(0);
    expect(stop).toBeLessThan(source.indexOf("migrate\", \"deploy\""));
    expect(stop).toBeLessThan(source.indexOf("luxia_retention_purge_transactions(1000, false)"));
    // Triggers: the catalog is read with the table, the function, the timing, the level, the operations and the state,
    // and the verdict comes from the checks module, whose own tests drive it to each failing answer.
    expect(source).not.toMatch(/Number\(triggers\) > 0/);
    expect(source).toContain("JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid");
    expect(source).toContain("t.tgname || '|' || c.relname || ' ' || p.proname");
    expect(source).toContain("(4, 'INSERT'), (8, 'DELETE'), (16, 'UPDATE'), (32, 'TRUNCATE')");
    expect(source).toContain("t.tgenabled::text");
    expect(source).toContain("const faults = triggerFaults(triggerLines);");
    // The server's address is judged, not only recorded, and both connections must answer the same copy.
    expect(source).toContain("const routable = publicAddress(ownerIdentity);");
    expect(source).toContain("routable === null");
    expect(source).toContain("const elsewhere = sameServer(ownerIdentity, appIdentity);");
    expect(source).toContain("const differentTargets = oneTarget(owner, app);");
  });
});
