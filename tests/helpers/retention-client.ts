// D8.4 (issue #150): the retention functions are executable by luxia_retention only, so the suites that call them
// connect as that role, exactly as the daily job does. app_user is refused before it reaches a function body, and the
// suites assert that too. LUXIA_RETENTION_DATABASE_URL is set by CI and by the local runner; a suite that needs it and
// does not find it fails loudly rather than falling back to another role, which would hide what it is testing.
import { PrismaClient } from "@prisma/client";

export function retentionTestClient(): PrismaClient {
  const url = process.env.LUXIA_RETENTION_DATABASE_URL;
  if (!url) throw new Error("LUXIA_RETENTION_DATABASE_URL is required: the retention functions are executable by luxia_retention only");
  return new PrismaClient({ datasources: { db: { url } } });
}
