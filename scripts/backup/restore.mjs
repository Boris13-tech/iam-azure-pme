// Restores a LUXIA independent backup into a BLANK PostgreSQL database, then proves the result against the
// inventory recorded inside the backup's snapshot: every table's row count and content hash, and the schema
// (constraints, indexes, RLS policies, functions, triggers, privileges). Any difference fails the restore.
// Operator side (docs/operations/BACKUP-RUNBOOK.md). The private key stays in the operator's file; the clear dump
// only flows through memory, from age to pg_restore, and is never written to disk.
//
//   LUXIA_RESTORE_TARGET_URL   owner of the blank target database
//   LUXIA_BACKUP_SOURCE_URL    blob container URL with a read+list SAS (or --from-dir <dir> for local files)
//   node scripts/backup/restore.mjs --identity <age key file> [--backup <path> | --latest] [--report <file>]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { USER_SCHEMAS, compareInventories, summarize, takeInventory } from "./inventory.mjs";
import { bin, fail, pgEnv, psql } from "./pg.mjs";

const decisionAt = new Date();
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const identity = option("--identity");
const fromDir = option("--from-dir");
const source = process.env.LUXIA_BACKUP_SOURCE_URL;
const target = process.env.LUXIA_RESTORE_TARGET_URL;
const ageBin = process.env.AGE_BIN || "age";
if (!identity || !target || (!fromDir && !source)) fail("usage: see the header of scripts/backup/restore.mjs");
const timings = {};
const step = async (name, work) => { const start = Date.now(); const result = await work(); timings[`${name}Ms`] = Date.now() - start; return result; };
const sha256 = buffer => createHash("sha256").update(buffer).digest("hex");

// 1. Locate and download. Every file is checked against the manifest before anything is decrypted.
const container = source ? new URL(source) : null;
const blobUrl = name => `${container.origin}${container.pathname.replace(/\/$/, "")}/${name}${container.search}`;
async function fetchBlob(name) {
  const response = await fetch(blobUrl(name), { headers: { "x-ms-version": "2023-11-03" } });
  if (!response.ok) fail(`download of ${name} failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
async function latestPath() {
  const prefix = option("--prefix") || "prod/";
  const names = [];
  let marker = "";
  do {
    const listUrl = new URL(blobUrl(""));
    listUrl.searchParams.set("restype", "container"); listUrl.searchParams.set("comp", "list"); listUrl.searchParams.set("prefix", prefix);
    if (marker) listUrl.searchParams.set("marker", marker);
    const response = await fetch(listUrl, { headers: { "x-ms-version": "2023-11-03" } });
    if (!response.ok) fail(`listing failed: HTTP ${response.status}`);
    const xml = await response.text();
    for (const match of xml.matchAll(/<Name>([^<]+\/manifest\.json)<\/Name>/g)) names.push(match[1]);
    marker = /<NextMarker>([^<]*)<\/NextMarker>/.exec(xml)?.[1] || "";
  } while (marker);
  if (!names.length) fail("no backup found");
  return names.sort().pop().replace(/\/manifest\.json$/, "");
}
const { manifest, files } = await step("download", async () => {
  const backupPath = fromDir ? null : (option("--backup") || (args.includes("--latest") ? await latestPath() : fail("pass --backup <path> or --latest")));
  const read = fromDir ? name => readFileSync(join(fromDir, name)) : name => fetchBlob(`${backupPath}/${name}`);
  const manifest = JSON.parse((await read("manifest.json")).toString("utf8"));
  if (manifest.format !== "luxia-backup/1") fail(`unknown manifest format ${manifest.format}`);
  const files = {};
  for (const file of manifest.files) {
    const buffer = await read(file.name);
    if (buffer.length !== file.bytes || sha256(buffer) !== file.sha256) fail(`${file.name} does not match the manifest (size or SHA-256)`);
    files[file.name] = buffer;
  }
  return { manifest, files };
});

// 2. The key must be the one the backup was encrypted to.
const recipient = spawnSync(process.env.AGE_KEYGEN_BIN || "age-keygen", ["-y", identity], { encoding: "utf8" });
if (recipient.status !== 0) fail("the identity file cannot be read by age-keygen");
if (recipient.stdout.trim() !== manifest.recipient) fail(`wrong key: this backup is encrypted to ${manifest.keyId}`);
const decrypt = input => spawnSync(ageBin, ["--decrypt", "-i", identity], { input, maxBuffer: 256 * 1024 * 1024 });
const opened = decrypt(files["inventory.json.age"]);
if (opened.status !== 0) fail("the inventory cannot be decrypted");
const recorded = JSON.parse(opened.stdout.toString("utf8"));
if (recorded.id !== manifest.id) fail("the inventory belongs to another backup");

// 3. The target must be blank: a restore never writes over an existing database.
const env = pgEnv(target, "luxia-restore");
await step("preflight", async () => {
  const [objects, serverVersionNum] = psql(env, `SELECT count(*), current_setting('server_version_num') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','S','f') AND ${USER_SCHEMAS};`).stdout.trim().split("|");
  if (objects !== "0") fail(`the target is not blank (${objects} relations): refusing to restore over it`);
  if (Math.floor(Number(serverVersionNum) / 10000) < Math.floor(recorded.meta.serverVersionNum / 10000)) fail("the target server is older than the source");
});

// 4. Roles are global objects, outside the dump. Create the missing ones, without login: credentials are set at
// cutover. A role with a powerful attribute is never created automatically.
const createdRoles = await step("roles", async () => {
  const existing = new Set(psql(env, "SELECT rolname FROM pg_roles;").stdout.split("\n").map(line => line.trim()).filter(Boolean));
  const created = [];
  for (const role of recorded.roles) {
    if (existing.has(role.name)) continue;
    if (role.super || role.replication || role.createrole || role.createdb) fail(`role ${role.name} needs privileged attributes: create it by hand first`);
    const name = `"${role.name.replace(/"/g, '""')}"`;
    psql(env, `CREATE ROLE ${name} NOLOGIN ${role.bypassrls ? "BYPASSRLS" : "NOBYPASSRLS"} ${role.inherit ? "INHERIT" : "NOINHERIT"};`);
    created.push(role.name);
  }
  return created;
});

// 5. Decrypt into pg_restore, in one transaction: the target ends either complete or untouched.
// With partial, pg_restore may stop reading early (--list reads only the table of contents): only its own
// exit code counts. A full restore requires both age and pg_restore to consume and succeed.
async function decryptInto(restoreArgs, hashTarget = null, { partial = false } = {}) {
  const age = spawn(ageBin, ["--decrypt", "-i", identity], { stdio: ["pipe", "pipe", "pipe"] });
  const restore = spawn(bin("pg_restore"), restoreArgs, { env, stdio: ["pipe", "pipe", "pipe"] });
  let ageErr = ""; let restoreErr = ""; let stdout = "";
  age.stderr.on("data", chunk => { ageErr += chunk; });
  restore.stderr.on("data", chunk => { restoreErr += chunk; });
  restore.stdout.on("data", chunk => { stdout += chunk; });
  const exited = child => new Promise(resolve => child.on("close", code => resolve(code)));
  const hashing = new Transform({ transform(chunk, _encoding, done) {
    if (hashTarget) { hashTarget.hash.update(chunk); hashTarget.bytes += chunk.length; }
    done(null, chunk);
  } });
  const flows = [pipeline(Readable.from([files["dump.pgc.age"]]), age.stdin), pipeline(age.stdout, hashing, restore.stdin)]
    .map(flow => partial ? flow.catch(() => undefined) : flow);
  const [ageCode, restoreCode] = await Promise.all([exited(age), exited(restore), ...flows]);
  if (ageCode !== 0 && !partial) fail(`decryption failed: ${ageErr.trim()}`);
  if (restoreCode !== 0) fail(`pg_restore failed (nothing was committed): ${restoreErr.trim().split("\n").slice(-4).join(" | ")}`);
  return { stdout };
}
const clear = { hash: createHash("sha256"), bytes: 0 };
const skippedEntries = [];
await step("restore", async () => {
  // Pass 1, the table of contents only. Default privileges of a role the restoring owner cannot act for are
  // platform settings (on Neon, cloud_admin's), already present on any target of that platform: they are left
  // out and listed in the report, and the inventory comparison below still checks that they match.
  const toc = await decryptInto(["--list"], null, { partial: true });
  const actable = new Map();
  const canActFor = role => {
    if (!actable.has(role)) actable.set(role, psql(env, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role.replace(/'/g, "''")}')
      AND pg_has_role(current_user, (SELECT oid FROM pg_roles WHERE rolname = '${role.replace(/'/g, "''")}'), 'USAGE');`).stdout.trim() === "t");
    return actable.get(role);
  };
  const list = toc.stdout.split(/\r?\n/).map(line => {
    const entry = /^\d+; \d+ \d+ DEFAULT ACL \S+ DEFAULT PRIVILEGES FOR \S+ (\S+)\s*$/.exec(line);
    if (entry && !canActFor(entry[1])) { skippedEntries.push(line.replace(/^\d+; \d+ \d+ /, "")); return `;${line}`; }
    return line;
  });
  const listFile = join(mkdtempSync(join(tmpdir(), "luxia-restore-")), "toc.list");
  writeFileSync(listFile, list.join("\n"));
  // Pass 2, the restore, in the archive's own order.
  await decryptInto([`--dbname=${env.PGDATABASE}`, `--use-list=${listFile}`, "--single-transaction", "--exit-on-error", "--no-password"], clear);
});
if (clear.hash.digest("hex") !== recorded.dump.sha256 || clear.bytes !== recorded.dump.bytes) fail("the decrypted dump does not match the recorded hash");
const restoredAt = new Date();

// 6. Proof: the restored database against the inventory taken in the backup's snapshot.
await step("analyze", async () => psql(env, "ANALYZE;"));
const restored = await step("inventory", async () => takeInventory(env));
const differences = compareInventories(recorded, restored);
const verifiedAt = new Date();

const report = {
  format: "luxia-restore-report/1", backup: manifest.id, path: manifest.path, keyId: manifest.keyId,
  snapshotAt: manifest.snapshotAt, decisionAt: decisionAt.toISOString(), restoredAt: restoredAt.toISOString(), verifiedAt: verifiedAt.toISOString(),
  // Data age at the moment the restore was decided (the RPO this backup gives), and time to a verified database.
  dataAgeSeconds: Math.round((decisionAt - new Date(manifest.snapshotAt)) / 1000),
  restoreToVerifiedSeconds: Math.round((verifiedAt - decisionAt) / 1000),
  timings, createdRoles, skippedEntries, dumpBytes: recorded.dump.bytes, encryptedBytes: manifest.files[0].bytes,
  source: summarize(recorded), restored: summarize(restored), differences, identical: differences.length === 0,
};
if (option("--report")) writeFileSync(option("--report"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, differences: differences.slice(0, 20) }, null, 2));
if (differences.length) fail(`${differences.length} difference(s) between the backup and the restored database`);
