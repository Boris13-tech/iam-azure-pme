// D8.4 (issue #150): the retention functions are executable by luxia_retention only, so the suites that call them
// connect as that role, exactly as the daily job does. app_user is refused before it reaches a function body, and the
// suites assert that too. LUXIA_RETENTION_DATABASE_URL is set by CI and by the local runner; a suite that needs it and
// does not find it fails loudly rather than falling back to another role, which would hide what it is testing.
//
// The failure comes when the client is first used, not when the module loads: the PostgreSQL suites are skipped when no
// database is configured, and an error at load time broke the collection of every file, including runs that need no
// database at all (Gemini 4 Hydrogen, fourth review of #196).
import { PrismaClient } from "@prisma/client";

const MISSING = "LUXIA_RETENTION_DATABASE_URL is required: the retention functions are executable by luxia_retention only";

export function retentionTestClient(): PrismaClient {
  const url = process.env.LUXIA_RETENTION_DATABASE_URL;
  if (!url) {
    return new Proxy({} as PrismaClient, {
      get: (_target, property) => (property === "$disconnect" ? async () => undefined : () => { throw new Error(MISSING); }),
    });
  }
  return new PrismaClient({ datasources: { db: { url } } });
}
