import { isProductionProcess } from "../auth/authorization-mode";

// G2-R04 (F-04): explicit Origin and Fetch-Metadata CSRF policy for cookie-authenticated mutations.
// NOTE: x-luxia-change-id is an audit-correlation and idempotency header; it is NEVER treated as a standalone
// CSRF defense. Browser state-changing requests are authorized only when Fetch Metadata (when sent) is same-origin
// AND Origin matches the application's canonical origin.

export type CsrfOriginFailureReason =
  | "CSRF_APP_URL_INVALID"
  | "CSRF_FETCH_SITE_FORBIDDEN"
  | "CSRF_ORIGIN_MISSING"
  | "CSRF_ORIGIN_MISMATCH";

export type CsrfOriginCheckResult =
  | Readonly<{ ok: true; expectedOrigin: string }>
  | Readonly<{ ok: false; reason: CsrfOriginFailureReason }>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function resolveTrustedAppOrigin(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const production = isProductionProcess(env);
  const configured = env.NEXT_PUBLIC_APP_URL?.trim();

  if (production) {
    if (!configured) return null;
    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch {
      return null;
    }
    const explicitlyCloudProd = env.VERCEL_ENV === "production" || env.APP_ENV === "production";
    const allowLocalHttp = !explicitlyCloudProd && LOOPBACK_HOSTS.has(parsed.hostname) && parsed.protocol === "http:";
    if (parsed.protocol !== "https:" && !allowLocalHttp) return null;
    return parsed.origin;
  }

  try {
    return new URL(configured || request.url).origin;
  } catch {
    return null;
  }
}

export function verifyMutationOrigin(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CsrfOriginCheckResult {
  const expectedOrigin = resolveTrustedAppOrigin(request, env);
  if (!expectedOrigin) {
    return { ok: false, reason: "CSRF_APP_URL_INVALID" };
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    return { ok: false, reason: "CSRF_FETCH_SITE_FORBIDDEN" };
  }

  const origin = request.headers.get("origin")?.trim();
  if (!origin) {
    // In Production or whenever browser Fetch Metadata is present, Origin is mandatory.
    // Direct in-process Vitest Request() calls outside Production carry neither header.
    if (isProductionProcess(env) || Boolean(fetchSite)) {
      return { ok: false, reason: "CSRF_ORIGIN_MISSING" };
    }
    return { ok: true, expectedOrigin };
  }

  if (origin !== expectedOrigin) {
    return { ok: false, reason: "CSRF_ORIGIN_MISMATCH" };
  }

  return { ok: true, expectedOrigin };
}
