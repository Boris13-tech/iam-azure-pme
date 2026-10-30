import { PrismaClient } from "@prisma/client";
import { signupCodeHash } from "../../../lib/onboarding/signup";
import { generateSignupCode } from "../../../scripts/operators/signup-codes";

// Operator side of the journeys, on the LOCAL test database only: a private-beta signup code is
// issued with the table owner connection, exactly as scripts/operators/signup-codes.ts does (only
// its SHA-256 is stored). Any host other than this machine is refused before connecting.
// Timeouts: a loaded Docker Desktop can take several seconds to open a connection (defaults 5 s and 10 s).
const DEFAULT_OWNER_URL = "postgresql://prisma:prisma_password@127.0.0.1:56544/luxia_db?schema=public&connect_timeout=60&pool_timeout=60";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function ownerDatabaseUrl(): string {
  const url = process.env.E2E_OWNER_DATABASE_URL || DEFAULT_OWNER_URL;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("E2E_OWNER_DATABASE_URL_INVALID"); }
  // Prisma lets these parameters override the URL's host: the name checked here would not be the server reached.
  if (!LOCAL_HOSTS.has(parsed.hostname) || parsed.searchParams.has("host") || parsed.searchParams.has("hostaddr")) throw new Error("E2E_OWNER_DATABASE_URL_NOT_LOCAL: the end-to-end suite only writes to a local database");
  return url;
}

/** A new single-use signup code, valid one day. Returned once; never logged. */
export async function issueSignupCode(): Promise<string> {
  const db = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  try {
    const code = generateSignupCode();
    await db.signupCode.create({ data: { codeHash: signupCodeHash(code)!, issuedBy: "e2e-passkeys", expiresAt: new Date(Date.now() + 86_400_000) } });
    return code;
  } finally {
    await db.$disconnect();
  }
}
