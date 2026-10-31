// Every test file starts here (vitest.config.ts). The PostgreSQL suites write fixtures and call global purges, so they
// run only against a test database: both connections reach one server and name the same database, called luxia_*.
// Production is neondb.
const port = (url: URL) => url.port || "5432";

export function assertTestDatabase(env: Readonly<Record<string, string | undefined>>) {
  if (env.LUXIA_RESOURCE_RLS !== "true") return;
  const [runtime, owner] = [env.DATABASE_URL, env.DATABASE_MIGRATION_URL].map((url) => {
    if (!url) throw new Error("ISOLATED_DB_REQUIRED");
    return new URL(url);
  });
  // Prisma lets these parameters override the URL's host: the name checked below would not be the server reached.
  if ([runtime, owner].some((url) => url.searchParams.has("host") || url.searchParams.has("hostaddr"))) throw new Error("ISOLATED_DB_REQUIRED");
  // A pooled runtime endpoint and its direct owner endpoint are one server; anything else is two.
  if (runtime.hostname.replace("-pooler.", ".") !== owner.hostname || port(runtime) !== port(owner)) throw new Error("ISOLATED_DB_REQUIRED");
  if (owner.pathname !== runtime.pathname) throw new Error("ISOLATED_DB_REQUIRED");
  if (!/^\/luxia_\w+$/.test(owner.pathname)) throw new Error("ISOLATED_DB_REQUIRED");
}

assertTestDatabase(process.env);
