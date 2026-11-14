// scripts/ops/verify-schema-release.sh: the database's applied migrations are exactly the release's. It runs here
// against a fake `psql` (no database): each case sets the history the database would report.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "verify-schema-"));
const bin = join(dir, "bin"); mkdirSync(bin);
// The fake answers the history query with FAKE_APPLIED (one name per line) and the count query with FAKE_UNFINISHED.
writeFileSync(join(bin, "psql"), `#!/usr/bin/env bash
for a in "$@"; do q="$a"; done
[ "\${FAKE_PSQL_FAIL:-}" = 1 ] && { echo "psql: connection refused" >&2; exit 2; }
case "$q" in
  *"count(*)"*) printf '%s\\n' "\${FAKE_UNFINISHED:-0}" ;;
  *migration_name*) printf '%b' "\${FAKE_APPLIED:-}" ;;
  *) exit 3 ;;
esac
`);
chmodSync(join(bin, "psql"), 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const RELEASE = ["20260917000000_init", "20261014090000_provider_connection_lifecycle", "20261023140000_organization_erasure"];
function release(names: string[]) {
  const root = mkdtempSync(join(dir, "release-"));
  for (const name of names) mkdirSync(join(root, name));
  writeFileSync(join(root, "migration_lock.toml"), 'provider = "postgresql"\n');
  return root;
}
function verify(applied: string[], env: Record<string, string> = {}, names = RELEASE) {
  const result = spawnSync("bash", ["scripts/ops/verify-schema-release.sh", release(names).replace(/\\/g, "/")], { encoding: "utf8",
    env: { ...process.env, PSQL_URL: "postgresql://u@h/db", FAKE_APPLIED: applied.map((n) => `${n}\\n`).join(""), PATH: `${bin}${delimiter}${process.env.PATH}`, ...env } });
  return { code: result.status, out: `${result.stdout}${result.stderr}`.replace(/\r/g, "") };
}

describe("verify-schema-release.sh: the schema is exactly the release's", () => {
  it("accepts the same migrations, whatever the order the database lists them in", () => {
    expect(verify([...RELEASE].reverse())).toEqual({ code: 0, out: "SCHEMA MATCHES 3 migrations\n" });
  });

  it("refuses a database behind the release (a migration not applied)", () => {
    const { code, out } = verify(RELEASE.slice(0, 2));
    expect(code).toBe(1);
    expect(out).toContain("not applied in the database, but in the release: 20261023140000_organization_erasure");
  });

  it("refuses a database ahead of the release (main's newer migrations applied)", () => {
    const { code, out } = verify([...RELEASE, "20261112100000_retention_status"]);
    expect(code).toBe(1);
    expect(out).toContain("applied in the database, but not in the release: 20261112100000_retention_status");
  });

  it("before the gate migrates: a database behind the release passes, one ahead of it is refused", () => {
    expect(verify(RELEASE.slice(0, 1), { }, RELEASE).code).toBe(1); // exact mode by default: behind is refused
    const behind = spawnSync("bash", ["scripts/ops/verify-schema-release.sh", release(RELEASE).replace(/\\/g, "/"), "--before-migrate"], { encoding: "utf8",
      env: { ...process.env, PSQL_URL: "postgresql://u@h/db", FAKE_APPLIED: `${RELEASE[0]}\\n`, PATH: `${bin}${delimiter}${process.env.PATH}` } });
    expect(behind.status).toBe(0);
    expect(behind.stdout.replace(/\r/g, "")).toBe("SCHEMA WITHIN RELEASE: 1 applied, 2 to apply\n");
    const ahead = spawnSync("bash", ["scripts/ops/verify-schema-release.sh", release(RELEASE).replace(/\\/g, "/"), "--before-migrate"], { encoding: "utf8",
      env: { ...process.env, PSQL_URL: "postgresql://u@h/db", FAKE_APPLIED: [...RELEASE, "20261112100000_retention_status"].map((n) => `${n}\\n`).join(""), PATH: `${bin}${delimiter}${process.env.PATH}` } });
    expect(ahead.status).toBe(1);
    expect(ahead.stdout).toContain("REFUSED: the database is ahead of the release");
    const mode = spawnSync("bash", ["scripts/ops/verify-schema-release.sh", release(RELEASE).replace(/\\/g, "/"), "--anything"], { encoding: "utf8",
      env: { ...process.env, PSQL_URL: "postgresql://u@h/db", PATH: `${bin}${delimiter}${process.env.PATH}` } });
    expect(mode.stdout).toContain("REFUSED: unknown mode --anything");
  });

  it("refuses a half-applied migration, an unreadable history, a release without migrations, and no database URL", () => {
    expect(verify(RELEASE, { FAKE_UNFINISHED: "1" }).out).toContain("REFUSED: a migration is half-applied");
    expect(verify(RELEASE, { FAKE_PSQL_FAIL: "1" }).out).toContain("REFUSED: the database's migration history cannot be read");
    expect(verify([], {}, []).out).toContain("REFUSED: the release has no migration");
    expect(verify(RELEASE, { PSQL_URL: "" }).out).toContain("REFUSED: PSQL_URL is not set");
  });
});
