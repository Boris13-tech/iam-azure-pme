// Minimum application monitoring, slice 2 (MINIMUM-APPLICATION-MONITORING-DESIGN.md, M-C and SLI-03).
// A minimal client of the Sentry envelope protocol, without an SDK: LUXIA builds every event itself, so no
// request, user, header, cookie, query string or body can leave (I5, E15). Any Sentry-protocol backend works
// (Sentry, GlitchTip, Bugsink): the DSN is the only coupling. Without a DSN, nothing is sent.

export type ErrorComponent = "session" | "request";
export const REPORT_TIMEOUT_MS = 1_500;

type Target = { url: string };

/** The envelope endpoint of a DSN `https://<key>@<host>/<project>`; null when missing or malformed. */
export function envelopeTarget(dsn = process.env.LUXIA_ERROR_DSN): Target | null {
  if (!dsn) return null;
  let parsed: URL;
  try { parsed = new URL(dsn); } catch { return null; }
  const project = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (parsed.protocol !== "https:" || !parsed.username || parsed.password || !/^\d{1,20}$/.test(project)) return null;
  const key = parsed.username;
  if (!/^[0-9a-f]{16,64}$/i.test(key)) return null;
  return { url: `https://${parsed.host}/api/${project}/envelope/?sentry_key=${key}&sentry_version=7` };
}

/**
 * What may leave, as closed lists defined in code (review follow-up of #108): a value is sent only when it is one of
 * these constants, never because of its shape. Function names, file paths and free text never leave; the component,
 * the route pattern and the release locate the error, and the full stack stays in the platform's own logs.
 * A new error class or code thrown in lib/ or app/ must be added here (a test fails otherwise), so a reviewer sees it.
 */
export const KNOWN_ERROR_TYPES: ReadonlySet<string> = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError",
  "PrismaClientKnownRequestError", "PrismaClientUnknownRequestError", "PrismaClientInitializationError", "PrismaClientValidationError",
  "PrismaClientRustPanicError", "AuthorizationInfrastructureError", "AuthorizationModeInvalidError", "CanonicalAdminError",
  "ContinuitySecurityError", "CryptoPolicyError", "InvitationError", "PortabilitySecurityError", "ProviderAdapterError",
  "ProviderIdempotencyConflictError", "ProviderRegistryError", "RecoveryError", "SessionCreationDeniedError", "SignupError",
  "SoDDeniedError", "UnsupportedProviderCapabilityError",
]);
export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  "AUTHZ_MODE_INVALID", "CROSS_ORGANIZATION_WRITE_DENIED", "CROSS_TENANT_WRITE_DENIED", "ENTITLEMENT_COLLISION",
  "INVALID_AUTHENTICATION_EVIDENCE", "INVALID_AUTHENTICATION_EVIDENCE_VERSION", "INVALID_CURSOR", "INVALID_PROJECTION_EVIDENCE",
  "INVALID_RETRY_POLICY", "LOCAL_IDENTITY_CREATION_FAILED", "ORGANIZATION_NOT_FOUND", "POSTURE_UNAVAILABLE", "PRODUCTION_SECRET_STORE_REQUIRED", "PUBLIC_KEY_UNAVAILABLE",
  "REJECTED_EVIDENCE_REQUIRED", "RETRY_EXHAUSTED", "RUNTIME_DRAINING", "RUNTIME_NOT_DRAINING", "RUNTIME_NOT_READY",
  "SIGN_IN_EVIDENCE_MISMATCH", "SUBJECT_READ_FAILED", "WEBAUTHN_UNAVAILABLE",
]);
const known = (set: ReadonlySet<string>, value: unknown, fallback: string) => (typeof value === "string" && set.has(value) ? value : fallback);

/** The event LUXIA sends: an allow-list of fields, nothing about the request or the person. */
export function buildEvent(error: unknown, component: ErrorComponent, routePath?: string) {
  const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Non-error thrown");
  const release = process.env.VERCEL_GIT_COMMIT_SHA;
  const route = routePath && /^[\w/[\].-]{1,120}$/.test(routePath) ? routePath : undefined;
  return {
    event_id: Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""),
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    environment: (process.env.APP_ENV || process.env.VERCEL_ENV || "unknown").replace(/[^\w-]/g, "").slice(0, 32),
    ...(release && /^[0-9a-f]{40}$/.test(release) ? { release } : {}),
    tags: { component, ...(route ? { route } : {}) },
    exception: { values: [{
      type: known(KNOWN_ERROR_TYPES, err.name, "Error"),
      value: known(KNOWN_ERROR_CODES, err.message, "<withheld>"),
    }] },
  };
}

/** Sends one error event. Never throws, never waits longer than the timeout, no-op without a DSN. */
export async function reportError(error: unknown, component: ErrorComponent, routePath?: string): Promise<boolean> {
  try {
    const target = envelopeTarget();
    if (!target) return false;
    const event = buildEvent(error, component, routePath);
    const body = `${JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REPORT_TIMEOUT_MS);
    try {
      const response = await fetch(target.url, { method: "POST", headers: { "content-type": "application/x-sentry-envelope" }, body, signal: abort.signal });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
