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
// A psql that records every call and the libpq variables it was given, and refuses nothing: a refusal must come from
// the script, never from the database.
writeFileSync(join(dir, "psql"), `#!/bin/sh
echo "$*" >> "${calls.replace(/\\/g, "/")}"
env | grep '^PG' >> "${env.replace(/\\/g, "/")}" || true
echo stub
`);
chmodSync(join(dir, "psql"), 0o755);
// The shebang is /bin/sh, not /usr/bin/env: the runs below see this directory alone, so env could not find bash.
// A spawned command is resolved without a shell, so a file named `psql` with a shebang is reachable on Linux, where
// CI runs, but not on Windows. Where it is unreachable, "it called no database" would hold for the wrong reason, so
// the checks that need the stub are skipped there, and CI asserts that it is reachable.
const stubReachable = spawnSync("psql", ["--version"], { encoding: "utf8", env: { ...process.env, PATH: dir } }).stdout?.includes("stub") === true;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LOCAL = "postgresql://restore_owner:p@127.0.0.1:15560/luxia_restore_rc";
const LOCAL_APP = "postgresql://app_user:p@127.0.0.1:15560/luxia_restore_rc";
const OK_ARGS = ["--release", "rc-private-beta-1", "--backup-age-minutes", "42", "--started", new Date().toISOString()];
const source = readFileSync("scripts/ops/g4-post-restore.mjs", "utf8");

function run(args: string[], overrides: Record<string, string | undefined> = {}) {
  writeFileSync(calls, "");
  writeFileSync(env, "");
  const result = spawnSync(process.execPath, ["scripts/ops/g4-post-restore.mjs", ...args], { encoding: "utf8",
    env: { ...process.env, LUXIA_RESTORE_TARGET_URL: LOCAL, LUXIA_RESTORE_APP_URL: LOCAL_APP, PATH: dir, ...overrides } });
  return { code: result.status, out: `${result.stdout}${result.stderr}`.replace(/\r/g, ""),
    calls: readFileSync(calls, "utf8"), pgEnv: readFileSync(env, "utf8") };
}

describe("G4 post-restore script: it can reach nothing but a disposable local copy", () => {
  it.runIf(process.env.CI)("in CI the stand-in psql is reachable, so the assertions below mean what they say", () => {
    expect(stubReachable).toBe(true);
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
    for (const database of ["neondb", "NEONDB", "neondb_prod", "luxia_db", "luxia_restored_elsewhere_x"].slice(0, 4)) {
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

  it.runIf(stubReachable)("clears every inherited libpq variable, so none can decide the target", () => {
    const { pgEnv, calls: made } = run(OK_ARGS, { PGHOSTADDR: "10.0.0.5", PGHOST: "db.example.com", PGPORT: "5432",
      PGUSER: "postgres", PGPASSWORD: "x", PGDATABASE: "neondb", PGSERVICE: "production", PGOPTIONS: "-c x=y" });
    expect(made).not.toBe("");          // it did call psql
    expect(pgEnv.trim()).toBe("");       // and psql saw no PG* variable at all
    // Both tools are given the same cleaned environment, and the same validated URL.
    expect(source).toContain("const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/.test(key)));");
    expect(source).toContain("{ encoding: \"utf8\", env: CLEAN_ENV }");
    expect(source).toContain("env: { ...CLEAN_ENV, DATABASE_URL: owner.url }");
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
    const direct = [...source.matchAll(/^const \w+ = psql\(owner\.url, `([^`]+)`\)/gm)].map((m) => m[1].trim());
    expect(direct).toEqual([
      "SELECT luxia_retention_purge_transactions(1000, false)::text",
      "SELECT luxia_retention_status()::text",
    ]);
    expect(source).toContain("wroteToTheCopy");
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
    // And the expected owner-only tables must still be owner-only, so none can drift out of the candidate set.
    expect(source).toContain('const EXPECTED_OWNER_ONLY = ["OrganizationErasure", "RateLimitBucket", "RateLimitConfig", "RetentionRun", "SignupCode"];');
    expect(source).toContain("the owner-only tables are all still owner-only");
    // Triggers: by name, with the function each runs and its enabled state, not a count.
    expect(source).not.toMatch(/Number\(triggers\) > 0/);
    const expected = /const EXPECTED_TRIGGERS = \{([\s\S]*?)\};/.exec(source)?.[1] ?? "";
    expect([...expected.matchAll(/^\s+(\w+): "(luxia_\w+)",$/gm)].length).toBeGreaterThanOrEqual(11);
    expect(source).toContain("is disabled");
    expect(source).toContain("t.tgname || '=' || p.proname || ':' || t.tgenabled");
  });
});
