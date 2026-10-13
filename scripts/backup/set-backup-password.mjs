// Sets or rotates the password of luxia_backup, and writes the backup connection string to a new file
// (for `gh secret set ... < file`, after which the file is deleted). The password is never printed and never on
// a command line. Neon accepts only plaintext passwords (it refuses a SCRAM verifier, observed 2026-10-13), so
// the password reaches the server over TLS, through psql's standard input, and errors are not echoed.
//
// LUXIA_OWNER_DATABASE_URL=<owner, direct endpoint> node scripts/backup/set-backup-password.mjs <new-output-file>
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { fail, pgEnv, psql } from "./pg.mjs";

const output = process.argv[2];
const owner = process.env.LUXIA_OWNER_DATABASE_URL;
if (!output || !owner) fail("usage: LUXIA_OWNER_DATABASE_URL=... node scripts/backup/set-backup-password.mjs <new-output-file>");
if (existsSync(output)) fail("the output file already exists");
const target = new URL(owner);
// pg_dump shares an exported snapshot with the inventory session: a transaction pooler cannot hold it.
if (target.hostname.includes("-pooler")) fail("use the direct endpoint, not the pooler");

const env = pgEnv(owner, "luxia-backup-password");
const exists = psql(env, "SELECT count(*) FROM pg_roles WHERE rolname = 'luxia_backup';").stdout.trim();
if (exists !== "1") fail("luxia_backup does not exist: run scripts/backup/luxia-backup-role.sql first");

const password = randomBytes(32).toString("base64url"); // 256 bits, URL-safe, no quote to escape
const set = psql(env, `ALTER ROLE luxia_backup PASSWORD '${password}';\n`, { allowFailure: true });
if (!set.ok) fail("the password could not be set (error output withheld because it may quote the statement)");

const url = new URL(owner);
url.username = "luxia_backup";
url.password = password;
url.search = "";
const local = ["localhost", "127.0.0.1"].includes(url.hostname);
url.searchParams.set("sslmode", local ? "disable" : "require");
if (!local) url.searchParams.set("channel_binding", "require");
writeFileSync(output, url.toString(), { flag: "wx", mode: 0o600 });

// Proves the new credential works and is the expected role, without printing it.
const check = psql(pgEnv(url.toString(), "luxia-backup-password-check"),
  "SELECT current_user || ' bypassrls=' || r.rolbypassrls || ' read_only=' || current_setting('default_transaction_read_only') FROM pg_roles r WHERE r.rolname = current_user;").stdout.trim();
console.log(`luxia_backup password set; login check: ${check}`);
