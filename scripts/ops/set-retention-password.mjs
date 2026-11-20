// Enables the login of luxia_retention (D8.4) and sets or rotates its password, then writes the job's connection
// string to a new file, for the operator to declare as LUXIA_RETENTION_DATABASE_URL on the Production environment and
// then delete. The password is generated here, never printed, never on a command line, and never typed by anyone.
//
// Neon refuses a SCRAM verifier (observed 2026-10-13, scripts/backup/set-backup-password.mjs), so psql's \password
// cannot be used there: the password reaches the server over TLS through psql's standard input, as it does for the
// backup role, and the statement's error output is never echoed, since it may quote it (Codex F3, tenth review).
//
// LUXIA_OWNER_DATABASE_URL=<owner, direct endpoint> node scripts/ops/set-retention-password.mjs <new-output-file>
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fail, pgEnv, psql } from "../backup/pg.mjs";

const output = process.argv[2];
const owner = process.env.LUXIA_OWNER_DATABASE_URL;
if (!output || !owner) fail("usage: LUXIA_OWNER_DATABASE_URL=... node scripts/ops/set-retention-password.mjs <new-output-file>");
if (existsSync(output)) fail("the output file already exists");
// The direct endpoint, as for the backup role: the query string is dropped below, and a pooled endpoint without its
// own parameters is not what the job's connection expects (Gemini 4 Neon F-02, eleventh review).
if (new URL(owner).hostname.includes("-pooler")) fail("use the direct endpoint, not the pooler");

const env = pgEnv(owner, "luxia-retention-password");
// The role must be the one D8.4 created and validated: it exists, and the migration that makes it is applied.
const state = psql(env, `SELECT (SELECT count(*) FROM pg_roles WHERE rolname = 'luxia_retention') || ' ' ||
  (SELECT count(*) FROM public._prisma_migrations WHERE migration_name = '20261114120000_retention_worker_role'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL);`).stdout.trim();
if (state !== "1 1") fail("luxia_retention or its migration (20261114120000_retention_worker_role) is not in this database");
// The role is the narrow one before it is given a login: the release's own validation, the block the migration and the
// activation gate run, is run here first, so every drift the gate refuses (an attribute, a grant to it or to PUBLIC, a
// setting, a member, an ownership) also stops the login (Codex F1, twelfth review).
const migration = readFileSync("prisma/migrations/20261114120000_retention_worker_role/migration.sql", "utf8");
const from = migration.indexOf("DO $$");
const validation = from < 0 ? "" : migration.slice(from, migration.indexOf("END $$;", from) + "END $$;".length);
if (!validation.includes("RETENTION_ROLE_UNSAFE")) fail("the release's worker-role validation was not found: run this from the release's checkout");
const validated = psql(env, `BEGIN READ ONLY;\n${validation}\nCOMMIT;\n`, { allowFailure: true });
if (!validated.ok) {
  // The refusal and its detail, which lists what is wrong (Gemini 4 Hydrogen F-03, thirteenth review).
  const reason = (validated.stderr ?? "").split("\n").filter((line) => /DETAIL|RETENTION_ROLE_UNSAFE/.test(line)).join(" ") || "validation failed";
  fail(`luxia_retention is not the narrow role, so no login was enabled: ${reason}`);
}

const password = randomBytes(32).toString("base64url"); // 256 bits, URL-safe, no quote to escape
const url = new URL(owner);
url.username = "luxia_retention";
url.password = password;
url.search = "";
const local = ["localhost", "127.0.0.1"].includes(url.hostname);
url.searchParams.set("sslmode", local ? "disable" : "require");
// No channel_binding: this string is read by Prisma, not libpq (Gemini 4 Hydrogen F-01, eleventh review); TLS is required.
// The new connection string is saved before the password changes: written the other way round, a file that could not
// be created left the database on a password nobody holds while the deployed secret still carried the old one (Codex
// F1, eleventh review). If the change then fails, the file is removed and the old password still works.
try {
  writeFileSync(output, url.toString(), { flag: "wx", mode: 0o600 });
} catch (error) {
  fail(`the output file could not be created, so the password was not changed: ${error instanceof Error ? error.code ?? error.message : error}`);
}
const set = psql(env, `ALTER ROLE luxia_retention LOGIN PASSWORD '${password}';\n`, { allowFailure: true });
// A failed client result does not prove the server rolled back: the connection can drop after the change committed
// (Codex F3, twelfth review). Only an error the server itself returned proves nothing was applied; in every other case
// the outcome is unknown, so the saved connection string is kept, never deleted on a guess (Codex F2, thirteenth review).
if (!set.ok) {
  const serverRefused = /(^|\n)(psql:[^\n]*)?ERROR:/.test(set.stderr ?? "");
  if (serverRefused) {
    try { unlinkSync(output); } catch { /* reported below */ }
    fail(`the server refused the change, so the login and the password are unchanged (error output withheld because it may quote the statement); ${existsSync(output) ? `delete ${output} by hand` : "the output file was removed"}`);
  }
  const probe = psql(pgEnv(url.toString(), "luxia-retention-password-probe"), "SELECT 1;", { allowFailure: true });
  if (!probe.ok) {
    fail(`the outcome of the change is unknown (the connection failed, and the new credential could not be tried): ${output} is kept. `
      + "Try it again later, or rotate once more; do not delete it until one of the two credentials is known to work");
  }
  console.error("The change was reported as failed, but the new credential logs in: it was applied. Continuing with the checks.");
}

// Takes the new login back when the worker cannot be shown to be the narrow one: the saved credential is deleted only
// once the login is known to be off; otherwise it is kept and the state reported (Codex F3, thirteenth review).
const takeBack = (reason) => {
  const revoked = psql(env, "ALTER ROLE luxia_retention NOLOGIN;\n", { allowFailure: true }).ok;
  if (revoked) { try { unlinkSync(output); } catch { /* reported below */ } }
  fail(`${reason}; its login was ${revoked ? "taken back" : `NOT taken back: disable it by hand (ALTER ROLE luxia_retention NOLOGIN), and keep ${output} until then`}`
    + `${revoked ? `, and ${existsSync(output) ? `${output} must be deleted by hand` : "the output file removed"}` : ""}`);
};
// Proves the new credential works and is the expected, narrow role, without printing it.
const checked = psql(pgEnv(url.toString(), "luxia-retention-password-check"),
  "SELECT current_user || ' session=' || session_user || ' superuser=' || r.rolsuper || ' bypassrls=' || r.rolbypassrls || ' inherit=' || r.rolinherit"
  + " || ' replication_role=' || current_setting('session_replication_role') || ' row_security=' || current_setting('row_security')"
  + " FROM pg_roles r WHERE r.rolname = current_user;", { allowFailure: true });
if (!checked.ok) takeBack("the new login could not be checked");
const check = checked.stdout.trim();
// The worker's own session, as it really starts: a server value masked for the validating role shows here (Codex F2,
// twelfth review).
if (check !== "luxia_retention session=luxia_retention superuser=false bypassrls=false inherit=false replication_role=origin row_security=on") {
  takeBack(`the new login does not start as the narrow worker (${check})`);
}
console.log(`luxia_retention login enabled and password set; login check: ${check}`);
console.log(`Declare the content of ${output} as LUXIA_RETENTION_DATABASE_URL on Vercel's Production environment, then delete the file.`);
