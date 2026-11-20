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
import { existsSync, writeFileSync } from "node:fs";
import { fail, pgEnv, psql } from "../backup/pg.mjs";

const output = process.argv[2];
const owner = process.env.LUXIA_OWNER_DATABASE_URL;
if (!output || !owner) fail("usage: LUXIA_OWNER_DATABASE_URL=... node scripts/ops/set-retention-password.mjs <new-output-file>");
if (existsSync(output)) fail("the output file already exists");

const env = pgEnv(owner, "luxia-retention-password");
// The role must be the one D8.4 created and validated: it exists, and the migration that makes it is applied.
const state = psql(env, `SELECT (SELECT count(*) FROM pg_roles WHERE rolname = 'luxia_retention') || ' ' ||
  (SELECT count(*) FROM public._prisma_migrations WHERE migration_name = '20261114120000_retention_worker_role'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL);`).stdout.trim();
if (state !== "1 1") fail("luxia_retention or its migration (20261114120000_retention_worker_role) is not in this database");

const password = randomBytes(32).toString("base64url"); // 256 bits, URL-safe, no quote to escape
const set = psql(env, `ALTER ROLE luxia_retention LOGIN PASSWORD '${password}';\n`, { allowFailure: true });
if (!set.ok) fail("the login or the password could not be set (error output withheld because it may quote the statement)");

const url = new URL(owner);
url.username = "luxia_retention";
url.password = password;
url.search = "";
const local = ["localhost", "127.0.0.1"].includes(url.hostname);
url.searchParams.set("sslmode", local ? "disable" : "require");
if (!local) url.searchParams.set("channel_binding", "require");
writeFileSync(output, url.toString(), { flag: "wx", mode: 0o600 });

// Proves the new credential works and is the expected, narrow role, without printing it.
const check = psql(pgEnv(url.toString(), "luxia-retention-password-check"),
  "SELECT current_user || ' session=' || session_user || ' superuser=' || r.rolsuper || ' bypassrls=' || r.rolbypassrls || ' inherit=' || r.rolinherit FROM pg_roles r WHERE r.rolname = current_user;").stdout.trim();
if (check !== "luxia_retention session=luxia_retention superuser=false bypassrls=false inherit=false") {
  fail(`the new login answered as an unexpected role: ${check}`);
}
console.log(`luxia_retention login enabled and password set; login check: ${check}`);
console.log(`Declare the content of ${output} as LUXIA_RETENTION_DATABASE_URL on the Production environment, then delete the file.`);
