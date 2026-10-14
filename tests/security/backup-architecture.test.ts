import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decide } from "../../scripts/backup/schedule-gate.mjs";

// Independent backup (docs/operations/INDEPENDENT-BACKUP-ARCHITECTURE.md): the rules that keep it safe, checked on
// every change. The backup side holds the public key only; the backup role can only read; a restore never writes
// over an existing database and either completes or changes nothing.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const workflow = read(".github/workflows/backup.yml");
const backup = read("scripts/backup/backup.mjs");
const restore = read("scripts/backup/restore.mjs");
const role = read("scripts/backup/luxia-backup-role.sql");
const SECRET_KEY_PREFIX = ["AGE", "SECRET", "KEY", "1"].join("-");

describe("Independent backup architecture", () => {
  it("the backup workflow runs on a schedule or by hand only, with read-only repository access and the protected environment", () => {
    expect(workflow).toMatch(/^on:\n  schedule:\n(    #.*\n)*    - cron: '[^']+'\n  workflow_dispatch:\n\n/m);
    expect(workflow).not.toMatch(/pull_request|push:/);
    expect(workflow).toMatch(/^permissions:\n  contents: read\n/m);
    expect(workflow).toMatch(/environment: production-backup/);
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40} /);
    expect(workflow).toMatch(/persist-credentials: false/);
    expect([...workflow.matchAll(/secrets\.(\w+)/g)].map(m => m[1]).sort()).toEqual(["LUXIA_BACKUP_CONTAINER_URL", "LUXIA_BACKUP_DATABASE_URL"]);
  });

  it("E4: the Azure dispatch is the primary trigger; GitHub's schedule is a fallback decided by a job that holds no secret", () => {
    const gate = workflow.slice(workflow.indexOf("\n  gate:\n"), workflow.indexOf("\n  backup:\n"));
    const backupJob = workflow.slice(workflow.indexOf("\n  backup:\n"));
    expect(gate).not.toMatch(/environment:|secrets\./);
    expect(gate).toMatch(/permissions:\n      contents: read\n      actions: read\n/);
    expect(gate).toContain(`if [ "$EVENT" != "schedule" ]; then echo "run=true"`);
    expect(gate).toMatch(/else\n\s+echo "run=true" >> "\$GITHUB_OUTPUT"; echo "gate: back up \(run history unavailable\)"/);
    expect(gate).toContain("node scripts/backup/schedule-gate.mjs \"$RUNNER_TEMP/runs.json\" \"$GITHUB_RUN_ID\" 65");
    // Every status is read (queued and running dispatches count), on main only.
    expect(gate).toContain("actions/workflows/backup.yml/runs?branch=main&per_page=30");
    expect(gate).not.toContain("status=success");
    expect(backupJob).toMatch(/^\n  backup:\n    needs: gate\n    if: needs.gate.outputs.run == 'true'\n/);
    expect(backupJob).toMatch(/environment: production-backup/);
  });

  it("E4: the schedule gate backs up unless a dispatched backup succeeded in the window, and fails open", () => {
    const now = Date.parse("2026-10-14T01:23:30Z");
    const run = (minutesAgo: number, extra: Record<string, unknown> = {}) => ({ id: minutesAgo, event: "workflow_dispatch", status: "completed",
      conclusion: "success", created_at: new Date(now - minutesAgo * 60_000).toISOString(), ...extra });
    expect(decide([run(30)], now, 999, 50)).toMatchObject({ run: false });            // Azure ran at :53: skip
    expect(decide([run(90)], now, 999, 50)).toMatchObject({ run: true });             // Azure missed :53: back up
    expect(decide([run(30, { conclusion: "failure" })], now, 999, 50)).toMatchObject({ run: true });
    expect(decide([run(30, { event: "schedule" })], now, 999, 50)).toMatchObject({ run: true }); // a scheduled run may have skipped: no proof
    expect(decide([run(30, { id: 999 })], now, 999, 50)).toMatchObject({ run: true });
    // A dispatched backup still queued or running is proof enough: no second, redundant scheduled backup.
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"])
      expect(decide([run(2, { status, conclusion: null })], now, 999, 65), status).toMatchObject({ run: false, reason: `dispatched-backup-${status}-2min-ago` });
    // ...but a dispatched run that failed or was cancelled is not, and neither is a dispatch on another branch.
    expect(decide([run(2, { conclusion: "cancelled" })], now, 999, 65)).toMatchObject({ run: true });
    expect(decide([run(2, { status: "queued", conclusion: null, head_branch: "feature" })], now, 999, 65)).toMatchObject({ run: true });
    // A scheduled run, even recent and successful or running, never proves that the Azure trigger works.
    expect(decide([run(5, { event: "schedule" }), run(1, { event: "schedule", status: "in_progress", conclusion: null })], now, 999, 65)).toMatchObject({ run: true });
    // The newest proof is reported.
    expect(decide([run(60), run(3, { status: "in_progress", conclusion: null })], now, 999, 65)).toMatchObject({ run: false, reason: "dispatched-backup-in_progress-3min-ago" });
    expect(decide([], now, 999, 50)).toMatchObject({ run: true });
    expect(decide(undefined as never, now, 999, 50)).toMatchObject({ run: true, reason: "unreadable" });
    expect(decide([run(30)], now, 999, Number.NaN)).toMatchObject({ run: true, reason: "unreadable" });
  });

  it("the backup side can encrypt only: no private key, no decryption, one public X25519 recipient with its key id", () => {
    for (const text of [workflow, backup]) {
      expect(text).not.toMatch(/--decrypt|\s-d\s|--identity|\s-i\s|IDENTITY/);
      expect(text).not.toContain(SECRET_KEY_PREFIX);
    }
    expect(backup).toMatch(/"--encrypt", "-r", recipient/);
    const recipients = read("scripts/backup/recipient.txt").split("\n").filter(line => line && !line.startsWith("#"));
    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatch(/^age1[02-9ac-hj-np-z]{58}$/);
    const keyId = createHash("sha256").update(recipients[0]).digest("hex").slice(0, 16);
    expect(read("scripts/backup/recipient.txt")).toContain(`keyId: age-x25519:${keyId}`);
  });

  it("no private key is tracked anywhere in the repository, and key files are ignored", () => {
    // git grep exits 1 when nothing matches.
    const search = spawnSync("git", ["grep", "-l", "-I", "-F", SECRET_KEY_PREFIX, "--", "."], { encoding: "utf8" });
    expect(search.status, search.stdout).toBe(1);
    expect(read(".gitignore")).toMatch(/^\*\.agekey$/m);
  });

  it("the dump is consistent, complete and never filtered: one snapshot, BYPASSRLS required, row security left off", () => {
    expect(backup).toMatch(/--snapshot=\$\{hold\.snapshot\}/);
    expect(backup).toMatch(/takeInventory\(env, hold\.snapshot\)/);
    expect(backup).toMatch(/if \(bypassrls !== "t"\) fail/);
    // The workstation emergency path (owner role standing in for luxia_backup) is refused inside GitHub Actions, and
    // the workflow never sets it.
    expect(backup).toContain(`const emergencyRole = process.env.GITHUB_ACTIONS === "true" ? null : process.env.LUXIA_BACKUP_EMERGENCY_ROLE || null;`);
    expect(backup).toMatch(/if \(user !== "luxia_backup" && user !== emergencyRole\) fail/);
    expect(workflow).not.toContain("LUXIA_BACKUP_EMERGENCY_ROLE");
    expect(backup).toMatch(/bin\("pg_dump"\), \["--format=custom"/);
    expect(backup).not.toMatch(/bin\("pg_dump"\), \[[^\]]*enable-row-security/);
    expect(read("scripts/backup/inventory.mjs")).toMatch(/SET LOCAL row_security = off;/);
    // Only declared platform schemas stay out (Neon Auth, unused by LUXIA); any other schema stops the backup.
    expect(read("scripts/backup/inventory.mjs")).toContain(`export const PLATFORM_SCHEMAS = ["neon_auth"];`);
    expect(backup).toMatch(/if \(unknownSchemas\.length\) fail\(/);
    expect(backup).toMatch(/excludedSchemas\.map\(name => `--exclude-schema=\$\{name\}`\)/);
    // The log is public: one summary line, without connection details or counts per table, and no error message
    // quotes a connection string.
    expect(backup.match(/console\.log\(/g)).toHaveLength(1);
    const summary = backup.slice(backup.indexOf("console.log("));
    expect(summary).not.toMatch(/databaseUrl|inventory\.tables|blobUrl|base\.search/);
    expect(backup).not.toMatch(/fail\(`[^`]*\$\{(databaseUrl|containerUrl|env\.)/);
  });

  it("the backup role grants SELECT only, holds no password, and checks its own attributes", () => {
    expect(role).not.toMatch(/PASSWORD\s+'/i);
    expect(role).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|TRUNCATE|ALL|EXECUTE|CREATE)/i);
    expect([...role.matchAll(/GRANT (\w+)/g)].map(m => m[1]).sort()).toEqual(["CONNECT", "SELECT", "SELECT", "SELECT", "SELECT", "USAGE"]);
    expect(role).toMatch(/NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT BYPASSRLS/);
    expect(role).toMatch(/RAISE EXCEPTION 'luxia_backup does not have the expected attributes/);
  });

  it("a restore refuses a non-blank target, checks every hash and the key, and commits all or nothing", () => {
    expect(restore).toMatch(/the target is not blank/);
    expect(restore).toMatch(/does not match the manifest \(size or SHA-256\)/);
    expect(restore).toMatch(/wrong key: this backup is encrypted to/);
    expect(restore).toMatch(/"--single-transaction", "--exit-on-error"/);
    expect(restore).toMatch(/the decrypted dump does not match the recorded hash/);
    expect(restore).toMatch(/compareInventories\(recorded, restored\)/);
    // The clear dump only flows through memory.
    expect(restore).not.toMatch(/writeFileSync\([^)]*(clear|dump\.pgc[^.])/);
  });
});
