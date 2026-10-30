// Every test file starts here (vitest.config.ts). The PostgreSQL suites write fixtures and call global purges, so they
// run only against a test database: both connections name the same database, called luxia_*. Production is neondb.
export function assertTestDatabase(env: Readonly<Record<string, string | undefined>>) {
  if (env.LUXIA_RESOURCE_RLS !== "true") return;
  const [runtime, owner] = [env.DATABASE_URL, env.DATABASE_MIGRATION_URL].map((url) => {
    if (!url) throw new Error("ISOLATED_DB_REQUIRED");
    return new URL(url);
  });
  if (!/^\/luxia_\w+$/.test(owner.pathname) || owner.pathname !== runtime.pathname) throw new Error("ISOLATED_DB_REQUIRED");
  // A pooled runtime endpoint and its direct owner endpoint are one server; anything else is two.
  if (runtime.hostname.replace("-pooler.", ".") !== owner.hostname) throw new Error("ISOLATED_DB_REQUIRED");
}

assertTestDatabase(process.env);
