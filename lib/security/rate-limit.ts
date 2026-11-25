import { createHash } from "node:crypto";
import { isProductionProcess } from "../auth/authorization-mode";
import { rawPrisma } from "../db/raw-prisma";

// Customer Self-Onboarding v1, requirement 3. Counters live in PostgreSQL (luxia_rate_limit_hit):
// only a peppered hash of SHA-256(client key) is stored, never an address or identifier.
// Per client network address unless stated. Sign-in limits allow a whole office behind one address
// to sign in at the same time; nothing there can be guessed (passkeys, decoys for unknown names).
export const RATE_LIMITS = {
  "login-begin": { windowSeconds: 600, max: 300 },
  "login-complete": { windowSeconds: 600, max: 300 },
  "login-entra": { windowSeconds: 600, max: 300 },
  "signup": { windowSeconds: 3600, max: 10 },
  "invitation-accept": { windowSeconds: 3600, max: 200 },
  "invitation-create": { windowSeconds: 86400, max: 500 }, // per administrator
  "dns-verify": { windowSeconds: 3600, max: 30 },          // per organization
  // B2 recovery codes (decision R3: limits only, never a lockout of the person).
  "recovery": { windowSeconds: 3600, max: 10 },            // recovery sign-in, per client
  "recovery-identity": { windowSeconds: 3600, max: 5 },    // recovery sign-in, per (organization, identifier)
  "recovery-generate": { windowSeconds: 86400, max: 5 },   // new batches, per person
} as const;
export type RateLimitScope = keyof typeof RATE_LIMITS;

const SAFE_HEADER_NAME = /^[a-z0-9-]{3,64}$/;
const SAFE_IP_TOKEN = /^[0-9a-fA-F:.]{2,64}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function cleanAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const candidate = raw.split(",")[0]?.trim() ?? "";
  return SAFE_IP_TOKEN.test(candidate) ? candidate.toLowerCase() : null;
}

function isLocalLoopbackApp(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.VERCEL_ENV === "production" || env.APP_ENV === "production") return false;
  const url = env.NEXT_PUBLIC_APP_URL?.trim();
  if (!url) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Client network key with explicit proxy trust boundary (G2-R06 / F-07):
 * 1. On Vercel (VERCEL === "1"): trusts only edge-overwritten `x-vercel-forwarded-for` or `x-real-ip`,
 *    never arbitrary `x-forwarded-for` hops when edge headers are absent.
 * 2. In Production outside Vercel: trusts ONLY the single-IP header explicitly declared in
 *    `LUXIA_TRUSTED_CLIENT_IP_HEADER` (stripped and overwritten by the trusted reverse proxy).
 *    Without it, spoofable `x-real-ip` and `x-forwarded-for` are ignored and all unverified requests
 *    share `"ip:untrusted-proxy"` so rate limits cannot be bypassed by header spoofing.
 * 3. In development, tests and local loopback E2E (`http://localhost:*`): accepts `x-real-ip` / `x-forwarded-for`.
 */
export function clientNetworkKey(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (env.VERCEL === "1") {
    const vercelIp =
      cleanAddress(request.headers.get("x-vercel-forwarded-for")) ??
      cleanAddress(request.headers.get("x-real-ip"));
    return `ip:${vercelIp ?? "vercel-unknown"}`;
  }

  if (isProductionProcess(env) && !isLocalLoopbackApp(env)) {
    const trustedHeader = env.LUXIA_TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
    if (!trustedHeader || !SAFE_HEADER_NAME.test(trustedHeader) || trustedHeader === "x-forwarded-for") {
      return "ip:untrusted-proxy";
    }
    const proxyIp = cleanAddress(request.headers.get(trustedHeader));
    return `ip:${proxyIp ?? "untrusted-proxy"}`;
  }

  const devOrTestIp =
    cleanAddress(request.headers.get("x-real-ip")) ??
    cleanAddress(request.headers.get("x-forwarded-for"));
  return `ip:${devOrTestIp ?? "unknown"}`;
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
