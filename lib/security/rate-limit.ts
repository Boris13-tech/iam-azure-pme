import { createHash } from "node:crypto";
import { rawPrisma } from "../db/raw-prisma";

// Customer Self-Onboarding v1, requirement 3. Counters live in PostgreSQL (luxia_rate_limit_hit):
// only a peppered hash of SHA-256(client key) is stored, never an address or identifier.
export const RATE_LIMITS = {
  "login-begin": { windowSeconds: 600, max: 30 },
  "login-complete": { windowSeconds: 600, max: 30 },
  "login-entra": { windowSeconds: 600, max: 30 },
  "signup": { windowSeconds: 3600, max: 10 },
  "invitation-accept": { windowSeconds: 3600, max: 20 },
  "invitation-create": { windowSeconds: 86400, max: 100 },
  "dns-verify": { windowSeconds: 3600, max: 30 },
} as const;
export type RateLimitScope = keyof typeof RATE_LIMITS;

/** Client network key. On Vercel, x-real-ip / x-forwarded-for are set by the platform. */
export function clientNetworkKey(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${real || forwarded || "unknown"}`;
}

/** True when the call is allowed. Fails closed: any database error counts as limited. */
export async function allowRequest(scope: RateLimitScope, key: string): Promise<boolean> {
  const { windowSeconds, max } = RATE_LIMITS[scope];
  const clientHash = createHash("sha256").update(key).digest("hex");
  try {
    const rows = await rawPrisma.$queryRaw<Array<{ ok: boolean }>>`
      SELECT luxia_rate_limit_hit(${scope}, ${clientHash}, ${windowSeconds}::int, ${max}::int) AS ok`;
    return rows[0]?.ok === true;
  } catch {
    console.error("RATE_LIMIT_UNAVAILABLE", scope);
    return false;
  }
}
