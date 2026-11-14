// G4: scripts/ops/g4-post-restore.mjs runs against a copy restored from a real backup, so its first duty is to refuse
// any target that is not a disposable local copy. These tests check every refusal without a database: a refused run
// must stop before it calls psql at all.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "g4-post-"));
const calls = join(dir, "calls.log");
// A psql that records every call and refuses nothing: a refusal must come from the script, never from the database.
writeFileSync(join(dir, "psql"), `#!/usr/bin/env bash\necho "$*" >> "${calls.replace(/\\/g, "/")}"\necho stub\n`);
chmodSync(join(dir, "psql"), 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LOCAL = "postgresql://restore_owner:p@127.0.0.1:15560/luxia_restore_rc";
const LOCAL_APP = "postgresql://app_user:p@127.0.0.1:15560/luxia_restore_rc";
const OK_ARGS = ["--release", "rc-private-beta-1", "--backup-age-minutes", "42", "--started", new Date().toISOString()];

function run(args: string[], env: Record<string, string | undefined> = {}) {
  writeFileSync(calls, "");
  const result = spawnSync(process.execPath, ["scripts/ops/g4-post-restore.mjs", ...args], { encoding: "utf8",
    env: { ...process.env, LUXIA_RESTORE_TARGET_URL: LOCAL, LUXIA_RESTORE_APP_URL: LOCAL_APP, PATH: `${dir}${delimiter}${process.env.PATH}`, ...env } });
  return { code: result.status, out: `${result.stdout}${result.stderr}`.replace(/\r/g, ""), calls: readFileSync(calls, "utf8") };
}

describe("G4 post-restore script: it refuses anything but a disposable local copy", () => {
  it("refuses a target that is not loopback, before touching any database", () => {
    for (const host of ["ep-cool-forest-123.eu-central-1.aws.neon.tech", "10.0.0.5", "db.example.com"]) {
      for (const which of ["LUXIA_RESTORE_TARGET_URL", "LUXIA_RESTORE_APP_URL"]) {
        const { code, out, calls: made } = run(OK_ARGS, { [which]: `postgresql://u:p@${host}:5432/luxia_copy` });
        expect(code, `${which} ${host}`).toBe(1);
        expect(out, `${which} ${host}`).toContain(`REFUSED: ${which} points at ${host.replace(/^\[|\]$/g, "")}`);
        expect(made, `${which} ${host}`).toBe("");
      }
    }
  });

  it("refuses the Production database by name, even on loopback (a tunnel would otherwise pass)", () => {
    for (const database of ["neondb", "NEONDB", "neondb_prod"]) {
      const { code, out, calls: made } = run(OK_ARGS, { LUXIA_RESTORE_TARGET_URL: `postgresql://u:p@127.0.0.1:15560/${database}` });
      expect(code, database).toBe(1);
      expect(out, database).toContain("names the Production database: refused");
      expect(made, database).toBe("");
    }
  });

  it("refuses a missing URL, a malformed URL, or a database name that is not plain", () => {
    expect(run(OK_ARGS, { LUXIA_RESTORE_TARGET_URL: undefined }).out).toContain("REFUSED: set LUXIA_RESTORE_TARGET_URL");
    expect(run(OK_ARGS, { LUXIA_RESTORE_APP_URL: undefined }).out).toContain("REFUSED: set LUXIA_RESTORE_TARGET_URL");
    expect(run(OK_ARGS, { LUXIA_RESTORE_TARGET_URL: "not a url" }).out).toContain("REFUSED: LUXIA_RESTORE_TARGET_URL is not a URL");
    const odd = run(OK_ARGS, { LUXIA_RESTORE_TARGET_URL: "postgresql://u:p@127.0.0.1:15560/luxia copy" });
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

  it("every database statement it sends is read-only or a dry run: it never writes to the restored copy", () => {
    const source = readFileSync("scripts/ops/g4-post-restore.mjs", "utf8");
    // Everything goes through readOnly, which wraps each statement in BEGIN READ ONLY, except exactly two calls: the
    // retention dry run and the status, which record their own run in the copy. A third would change this and must be
    // reviewed. The migrations go through Prisma.
    expect(source).toMatch(/const readOnly = \(url, sql\) => psql\(url, `BEGIN READ ONLY;/);
    const direct = [...source.matchAll(/^const \w+ = psql\(ownerUrl, `([^`]+)`\)/gm)].map((m) => m[1].trim());
    expect(direct).toEqual([
      "SELECT luxia_retention_purge_transactions(1000, false)::text",
      "SELECT luxia_retention_status()::text",
    ]);
    expect(source).toContain("wroteToTheCopy");
    // Every statement it sends is a SELECT: PostgreSQL would refuse a write inside BEGIN READ ONLY, and this shows
    // none is even written. The privilege names in the checks ('TRUNCATE' and the others) are values, not statements.
    const sent = [...source.matchAll(/readOnly\([^,]+,\s*`\s*([A-Za-z]+)/g)].map((m) => m[1].toUpperCase());
    expect(sent.length).toBeGreaterThanOrEqual(6);
    expect([...new Set(sent)]).toEqual(["SELECT"]);
    for (const forbidden of [/\bDELETE FROM\b/, /\bTRUNCATE "/, /\bUPDATE "\w+" SET/, /\bINSERT INTO\b/, /\bALTER (TABLE|ROLE)\b/,
      /luxia_retention_purge_\w+\([^)]*true/, /luxia_retention_pseudonymize_\w+\([^)]*true/, /luxia_organization_erase/, /luxia_retention_hold_(place|renew|release)/])
      expect(source, String(forbidden)).not.toMatch(forbidden);
    // The retention entry points it calls are dry runs, and the report holds counts only.
    expect(source).toContain("luxia_retention_purge_transactions(1000, false)");
    expect(source).toContain("estimatedRowsPerTable");
  });
});
