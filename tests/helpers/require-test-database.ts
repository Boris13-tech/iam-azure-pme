// Every test file starts here (vitest.config.ts). Suites write fixtures and call global purges, with or without the
// LUXIA_RESOURCE_RLS flag, so any connection set here must name a test database, called luxia_*. With the flag, both
// connections are required and must reach one server and name the same database.
// Production is neondb.
const port = (url: URL) => url.port || "5432";

export function assertTestDatabase(env: Readonly<Record<string, string | undefined>>) {
  if (env.LUXIA_RESOURCE_RLS !== "true") {
    for (const url of [env.DATABASE_URL, env.DATABASE_MIGRATION_URL]) {
      if (!url) continue;
      const target = new URL(url);
      if (target.searchParams.has("host") || target.searchParams.has("hostaddr") || !/^\/luxia_\w+$/.test(target.pathname)) throw new Error("ISOLATED_DB_REQUIRED");
    }
    return;
  }
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
// With no URL set, Prisma would fall back to a local .env file, which the check above never sees. It does not override a
// variable that is already set, so a test that connects now fails on this closed port instead.
process.env.DATABASE_URL ||= "postgresql://none@127.0.0.1:1/luxia_no_database";
