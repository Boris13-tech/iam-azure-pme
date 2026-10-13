// LUXIA independent backup (docs/operations/INDEPENDENT-BACKUP-ARCHITECTURE.md):
// one snapshot → pg_dump (custom format, compressed) → age encryption to the backup PUBLIC key → SHA-256 →
// upload to EU object storage that refuses deletion → download again and compare the hashes.
// The job can write backups but never read them: it holds no private key. It prints no row count and no secret.
//
// Environment:
//   LUXIA_BACKUP_DATABASE_URL    luxia_backup on the direct endpoint (secret)
//   LUXIA_BACKUP_CONTAINER_URL   blob container URL with a create+read SAS (secret). Without it, --out <dir> keeps
//                                the encrypted files locally (CI round trip).
//   LUXIA_BACKUP_RECIPIENT_FILE  default scripts/backup/recipient.txt
//   LUXIA_BACKUP_PREFIX          default "prod"
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PLATFORM_SCHEMAS, summarize, takeInventory } from "./inventory.mjs";
import { bin, fail, holdSnapshot, pgEnv, psql, toolMajor } from "./pg.mjs";

const started = Date.now();
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const containerUrl = process.env.LUXIA_BACKUP_CONTAINER_URL;
const databaseUrl = process.env.LUXIA_BACKUP_DATABASE_URL;
if (!databaseUrl) fail("LUXIA_BACKUP_DATABASE_URL is not set");
if (!containerUrl && outIndex < 0) fail("set LUXIA_BACKUP_CONTAINER_URL, or pass --out <dir> for a local run");
const prefix = (process.env.LUXIA_BACKUP_PREFIX || "prod").replace(/[^a-z0-9-]/g, "");

// 1. The public key. One X25519 recipient; its fingerprint is the key id written in every manifest.
const recipientFile = process.env.LUXIA_BACKUP_RECIPIENT_FILE || new URL("./recipient.txt", import.meta.url);
const recipients = readFileSync(recipientFile, "utf8").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
if (recipients.length !== 1 || !/^age1[02-9ac-hj-np-z]{58}$/.test(recipients[0])) fail("the recipient file must hold exactly one age X25519 public key");
const recipient = recipients[0];
const keyId = `age-x25519:${createHash("sha256").update(recipient).digest("hex").slice(0, 16)}`;

// 2. Tools and identity of the connection.
const pgDump = toolMajor("pg_dump");
const ageVersion = spawnSync(process.env.AGE_BIN || "age", ["--version"], { encoding: "utf8" });
if (ageVersion.error || ageVersion.status !== 0) fail("age is not available");
const env = pgEnv(databaseUrl, "luxia-backup");
const [user, bypassrls, serverVersionNum] = psql(env, "SELECT current_user, r.rolbypassrls, current_setting('server_version_num') FROM pg_roles r WHERE r.rolname = current_user;")
  .stdout.trim().split("|");
// Emergency catch-up when GitHub cannot run the job (docs/operations/BACKUP-RUNBOOK.md, section 2): from the
// operator's workstation only, the owner role named in LUXIA_BACKUP_EMERGENCY_ROLE may stand in for luxia_backup.
// The dump stays read-only and is encrypted to the same public key. Never accepted inside GitHub Actions.
const emergencyRole = process.env.GITHUB_ACTIONS === "true" ? null : process.env.LUXIA_BACKUP_EMERGENCY_ROLE || null;
if (user !== "luxia_backup" && user !== emergencyRole) fail(`connected as ${user}, expected luxia_backup`);
// Without BYPASSRLS a dump either stops on the first tenant table or, with --enable-row-security, silently
// exports none of their rows. A backup that holds part of the tenants is worse than none.
if (bypassrls !== "t") fail("luxia_backup lacks BYPASSRLS: the dump would not hold every tenant");
if (pgDump.major < Math.floor(Number(serverVersionNum) / 10000)) fail(`pg_dump ${pgDump.major} is older than the server`);
// Scope: everything except the declared platform schemas. An unknown schema stops the backup.
const schemas = psql(env, "SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public') AND nspname !~ '^pg_(toast|temp)' ORDER BY 1;")
  .stdout.split("\n").map(line => line.trim()).filter(Boolean);
const unknownSchemas = schemas.filter(name => !PLATFORM_SCHEMAS.includes(name));
if (unknownSchemas.length) fail(`schema(s) ${unknownSchemas.join(", ")} would be left out: grant them to luxia_backup or declare them as platform schemas`);
const excludedSchemas = schemas.filter(name => PLATFORM_SCHEMAS.includes(name));

// 3. One snapshot for the inventory and the dump.
const hold = await holdSnapshot(env);
const id = `${hold.snapshotAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomBytes(3).toString("hex")}`;
const path = `${prefix}/${hold.snapshotAt.slice(0, 4)}/${hold.snapshotAt.slice(5, 7)}/${hold.snapshotAt.slice(8, 10)}/${id}`;
const outDir = outIndex >= 0 ? args[outIndex + 1] : join(process.env.RUNNER_TEMP || ".", `luxia-backup-${id}`);
mkdirSync(outDir, { recursive: true });
const timings = {};
let mark = Date.now();
const inventory = takeInventory(env, hold.snapshot);
timings.inventoryMs = Date.now() - mark;

function hashing(target) {
  return new Transform({ transform(chunk, _encoding, done) { target.hash.update(chunk); target.bytes += chunk.length; done(null, chunk); } });
}
mark = Date.now();
const clear = { hash: createHash("sha256"), bytes: 0 };
const sealed = { hash: createHash("sha256"), bytes: 0 };
const dump = spawn(bin("pg_dump"), ["--format=custom", "--compress=6", `--snapshot=${hold.snapshot}`, "--no-password", "--lock-wait-timeout=60000",
  ...excludedSchemas.map(name => `--exclude-schema=${name}`)],
  { env, stdio: ["ignore", "pipe", "pipe"] });
const age = spawn(process.env.AGE_BIN || "age", ["--encrypt", "-r", recipient], { stdio: ["pipe", "pipe", "pipe"] });
let dumpErr = ""; let ageErr = "";
dump.stderr.on("data", chunk => { dumpErr += chunk; });
age.stderr.on("data", chunk => { ageErr += chunk; });
const exited = child => new Promise(resolve => child.on("close", code => resolve(code)));
const [dumpCode, ageCode] = await Promise.all([
  exited(dump), exited(age),
  pipeline(dump.stdout, hashing(clear), age.stdin),
  pipeline(age.stdout, hashing(sealed), createWriteStream(join(outDir, "dump.pgc.age"))),
]);
timings.dumpMs = Date.now() - mark;
await hold.release();
if (dumpCode !== 0) fail(`pg_dump failed: ${dumpErr.trim().split("\n").slice(-2).join(" | ")}`);
if (ageCode !== 0) fail(`age failed: ${ageErr.trim()}`);
if (clear.bytes === 0) fail("empty dump");

// 4. The inventory travels encrypted with the dump: it proves, at restore time, that nothing was lost.
const inventoryDocument = JSON.stringify({
  format: "luxia-backup-inventory/1", id, snapshotAt: hold.snapshotAt,
  dump: { sha256: clear.hash.digest("hex"), bytes: clear.bytes, pgDump: pgDump.version }, ...inventory,
});
const sealedInventory = spawnSync(process.env.AGE_BIN || "age", ["--encrypt", "-r", recipient], { input: inventoryDocument, maxBuffer: 256 * 1024 * 1024 });
if (sealedInventory.status !== 0) fail("age failed on the inventory");
writeFileSync(join(outDir, "inventory.json.age"), sealedInventory.stdout);

const sha256 = buffer => createHash("sha256").update(buffer).digest("hex");
const files = [
  { name: "dump.pgc.age", bytes: sealed.bytes, sha256: sealed.hash.digest("hex"), contentType: "application/octet-stream" },
  { name: "inventory.json.age", bytes: sealedInventory.stdout.length, sha256: sha256(sealedInventory.stdout), contentType: "application/octet-stream" },
];
const summary = summarize(inventory);
const manifest = {
  format: "luxia-backup/1", id, path, keyId, recipient,
  snapshotAt: hold.snapshotAt, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
  source: { serverVersionNum: Number(serverVersionNum), migrations: inventory.meta.migrations, lastMigration: inventory.meta.lastMigration, tables: summary.tables },
  excludedSchemas,
  tools: { pgDump: pgDump.version, age: ageVersion.stdout.trim() },
  run: { repository: process.env.GITHUB_REPOSITORY || null, commit: process.env.GITHUB_SHA || null, runId: process.env.GITHUB_RUN_ID || null,
    role: user, emergency: user !== "luxia_backup" },
  timings, files: files.map(({ contentType, ...file }) => file),
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

// 5. Upload: the files first, the manifest last (a manifest means a complete backup). Then read back and compare.
if (containerUrl) {
  const base = new URL(containerUrl);
  const blobUrl = name => `${base.origin}${base.pathname.replace(/\/$/, "")}/${path}/${name}${base.search}`;
  const headers = { "x-ms-version": "2023-11-03" };
  mark = Date.now();
  for (const file of [...files, { name: "manifest.json", contentType: "application/json" }]) {
    const body = readFileSync(join(outDir, file.name));
    const response = await fetch(blobUrl(file.name), { method: "PUT", body, headers: { ...headers, "x-ms-blob-type": "BlockBlob", "content-type": file.contentType } });
    if (response.status !== 201) fail(`upload of ${file.name} refused: HTTP ${response.status} ${(await response.text()).slice(0, 200).replace(/sig=[^&"<\s]+/g, "sig=<redacted>")}`);
  }
  timings.uploadMs = Date.now() - mark;
  mark = Date.now();
  for (const file of [...files, { name: "manifest.json", sha256: sha256(readFileSync(join(outDir, "manifest.json"))) }]) {
    const response = await fetch(blobUrl(file.name), { headers });
    if (!response.ok) fail(`read-back of ${file.name} failed: HTTP ${response.status}`);
    if (sha256(Buffer.from(await response.arrayBuffer())) !== file.sha256) fail(`read-back of ${file.name} does not match its hash`);
  }
  timings.verifyMs = Date.now() - mark;
}

console.log(JSON.stringify({
  backup: id, path, snapshotAt: hold.snapshotAt, keyId, uploaded: Boolean(containerUrl), verified: Boolean(containerUrl),
  dumpBytes: files[0].bytes, tables: summary.tables, migrations: inventory.meta.migrations, totalMs: Date.now() - started, timings,
}));
