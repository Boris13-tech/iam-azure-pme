// Shared PostgreSQL helpers for the independent backup. Node built-ins only: the backup job holds a
// credential that reads every tenant, so it installs no npm dependency.
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

export function fail(message) {
  console.error(`BACKUP_ERROR: ${message}`);
  process.exit(1);
}

// Connection parameters go through libpq environment variables, never through a command line or a log.
export function pgEnv(connectionString, applicationName) {
  let url;
  try { url = new URL(connectionString); } catch { fail("the connection string is not a valid URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) fail("the connection string is not a PostgreSQL URL");
  const params = url.searchParams;
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    PGSSLMODE: params.get("sslmode") || (["localhost", "127.0.0.1"].includes(url.hostname) ? "disable" : "require"),
    ...(params.get("channel_binding") ? { PGCHANNELBINDING: params.get("channel_binding") } : {}),
    PGAPPNAME: applicationName,
    PGCONNECT_TIMEOUT: "30",
  };
}

export function hostOf(connectionString) {
  return new URL(connectionString).hostname;
}

export function bin(name) {
  return process.env.PG_BIN ? join(process.env.PG_BIN, name) : name;
}

// Runs SQL through psql's standard input and returns its unaligned output. Fails on the first SQL error.
export function psql(env, sql, { allowFailure = false } = {}) {
  const result = spawnSync(bin("psql"), ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], { env, input: sql, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) fail(`psql could not start: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) fail(`psql failed: ${(result.stderr || "").trim().split("\n").slice(-3).join(" | ")}`);
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

export function jsonLines(stdout) {
  return stdout.split("\n").map(line => line.trim()).filter(line => line.startsWith("{")).map(line => JSON.parse(line));
}

export function toolMajor(name) {
  const result = spawnSync(bin(name), ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) fail(`${name} is not available`);
  const match = /(\d+)(?:\.(\d+))?/.exec(result.stdout);
  return { major: Number(match[1]), version: result.stdout.trim() };
}

// A psql session that holds a REPEATABLE READ transaction open and exports its snapshot, so pg_dump and the
// inventory read exactly the same state of the database.
export function holdSnapshot(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin("psql"), ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("snapshot export timed out")); }, 120_000);
    child.stdout.on("data", chunk => {
      out += chunk;
      const match = /SNAPSHOT\|([^|\s]+)\|([^|\s]+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({
          snapshot: match[1],
          snapshotAt: match[2],
          release: () => new Promise(done => { child.on("close", code => done(code)); child.stdin.end("COMMIT;\n"); }),
        });
      }
    });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("close", code => { clearTimeout(timer); if (!/SNAPSHOT\|/.test(out)) reject(new Error(`snapshot session ended (${code}): ${err.trim().split("\n").pop()}`)); });
    child.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n"
      + "SELECT 'SNAPSHOT|' || pg_export_snapshot() || '|' || to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"');\n");
  });
}
