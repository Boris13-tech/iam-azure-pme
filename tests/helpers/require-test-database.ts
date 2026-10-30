// Every test file starts here (vitest.config.ts). The PostgreSQL suites write fixtures and call global purges, so they
// run only against a test database: both connections reach one server and name the same database, called luxia_*.
// Production is neondb. One flow may use neondb: the registered certification runner, on its exact clone endpoint and
// roles, named by its own flags (scripts/certification/run-resources-diagnostic.ps1, modes runner and runner-negative).
const RUNNER_CLONE = { runtimeHost: "ep-weathered-grass-ah5vrehj-pooler.c-3.us-east-1.aws.neon.tech", ownerHost: "ep-weathered-grass-ah5vrehj.c-3.us-east-1.aws.neon.tech" };
const port = (url: URL) => url.port || "5432";

function isRegisteredRunner(env: Readonly<Record<string, string | undefined>>, runtime: URL, owner: URL) {
  // Exactly one of the two modes, as the runner sets them.
  if ((env.LUXIA_PRODUCTION_RUNNER_CERTIFICATION === "true") === (env.LUXIA_PRODUCTION_RUNNER_NEGATIVES === "true")) return false;
  return runtime.hostname === RUNNER_CLONE.runtimeHost && owner.hostname === RUNNER_CLONE.ownerHost
    && runtime.pathname === "/neondb" && owner.pathname === "/neondb"
    && runtime.username === "app_user" && owner.username === "neondb_owner";
}

export function assertTestDatabase(env: Readonly<Record<string, string | undefined>>) {
  if (env.LUXIA_RESOURCE_RLS !== "true") return;
  const [runtime, owner] = [env.DATABASE_URL, env.DATABASE_MIGRATION_URL].map((url) => {
    if (!url) throw new Error("ISOLATED_DB_REQUIRED");
    return new URL(url);
  });
  // A pooled runtime endpoint and its direct owner endpoint are one server; anything else is two.
  if (runtime.hostname.replace("-pooler.", ".") !== owner.hostname || port(runtime) !== port(owner)) throw new Error("ISOLATED_DB_REQUIRED");
  if (owner.pathname !== runtime.pathname) throw new Error("ISOLATED_DB_REQUIRED");
  if (!/^\/luxia_\w+$/.test(owner.pathname) && !isRegisteredRunner(env, runtime, owner)) throw new Error("ISOLATED_DB_REQUIRED");
}

assertTestDatabase(process.env);
