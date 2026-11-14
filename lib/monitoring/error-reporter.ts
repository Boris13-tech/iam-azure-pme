// Minimum application monitoring, slice 2 (MINIMUM-APPLICATION-MONITORING-DESIGN.md, M-C and SLI-03).
// A minimal client of the Sentry envelope protocol, without an SDK: LUXIA builds every event itself, so no
// request, user, header, cookie, query string or body can leave (I5, E15). Any Sentry-protocol backend works
// (Sentry, GlitchTip, Bugsink): the DSN is the only coupling. Without a DSN, nothing is sent.

export type ErrorComponent = "session" | "request" | "retention";
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
  "READINESS_DATABASE_ROLE", "READINESS_TIMEOUT", "READINESS_UNEXPECTED_SESSION", "REJECTED_EVIDENCE_REQUIRED",
  // Retention (D8.3): the daily job's alerts, the refusals of its database functions, and the alert drills.
  "RETENTION_ALERT_DRILL_BACKLOG", "RETENTION_ALERT_DRILL_FAILED_RUN", "RETENTION_ALREADY_RUNNING", "RETENTION_ARGUMENT_OUT_OF_RANGE",
  "RETENTION_BACKLOG", "RETENTION_FAILED", "RETENTION_HOLD_REQUIRES_BYPASSRLS", "RETENTION_HOLD_REVIEW_OVERDUE", "RETENTION_OWNER_REQUIRES_BYPASSRLS",
  "RETENTION_R4_ENFORCE_NOT_ACTIVATED", "RETENTION_R6_ENFORCE_NOT_ACTIVATED", "RETENTION_REQUIRES_READ_COMMITTED",
  "RETRY_EXHAUSTED", "RUNTIME_DRAINING", "RUNTIME_NOT_DRAINING", "RUNTIME_NOT_READY",
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

/** One envelope item to the backend. Never throws, no-op without a DSN; its own request is cancelled after the timeout. */
async function send(header: Record<string, string>, type: "event" | "check_in", payload: unknown): Promise<boolean> {
  try {
    const target = envelopeTarget();
    if (!target) return false;
    const body = `${JSON.stringify({ ...header, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type })}\n${JSON.stringify(payload)}\n`;
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

/**
 * Sends one error event. Never throws, no-op without a DSN, and its request is cancelled after REPORT_TIMEOUT_MS: a
 * caller's own work is already done when it reports, so nothing here may turn it into a failure (Codex, review of #193).
 */
export async function reportError(error: unknown, component: ErrorComponent, routePath?: string): Promise<boolean> {
  try {
    if (!envelopeTarget()) return false;
    const event = buildEvent(error, component, routePath);
    return await send({ event_id: event.event_id }, "event", event);
  } catch { return false; }
}

/**
 * Scheduled jobs the watcher expects to hear from (Sentry check-in protocol, D8.3): a closed list, defined in code.
 * The watcher raises its alert after `missesBeforeAlert` consecutive missed or failed check-ins. The daily retention
 * run: 3 misses is the "no run for 3 days" alert of the Private Beta scope (4.1). The drill monitor expects a check-in
 * every minute, so that sending one and then nothing proves the silence alert within minutes.
 */
export const CHECK_IN_MONITORS = {
  "retention-daily": { schedule: "7 3 * * *", marginMinutes: 180, maxRuntimeMinutes: 5, missesBeforeAlert: 3 },
  "retention-daily-drill": { schedule: "* * * * *", marginMinutes: 1, maxRuntimeMinutes: 1, missesBeforeAlert: 3 },
} as const;
export type CheckInMonitor = keyof typeof CHECK_IN_MONITORS;

/** The check-in LUXIA sends: the monitor's fixed configuration and a status, nothing else. */
export function buildCheckIn(monitor: CheckInMonitor, status: "ok" | "error") {
  const config = CHECK_IN_MONITORS[monitor];
  return {
    check_in_id: Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""),
    monitor_slug: monitor,
    status,
    environment: (process.env.APP_ENV || process.env.VERCEL_ENV || "unknown").replace(/[^\w-]/g, "").slice(0, 32),
    monitor_config: {
      schedule: { type: "crontab", value: config.schedule },
      checkin_margin: config.marginMinutes,
      max_runtime: config.maxRuntimeMinutes,
      timezone: "UTC",
      failure_issue_threshold: config.missesBeforeAlert,
      recovery_threshold: 1,
    },
  };
}

/** Sends one check-in. Never throws, no-op without a DSN; its request is cancelled after REPORT_TIMEOUT_MS. */
export async function reportCheckIn(monitor: CheckInMonitor, status: "ok" | "error"): Promise<boolean> {
  try {
    if (!Object.hasOwn(CHECK_IN_MONITORS, monitor) || (status !== "ok" && status !== "error")) return false;
    // Building the check-in is inside the boundary too: it reads the clock and the random source, and a failure there
    // must not reach the caller (Codex, review of #193).
    if (!envelopeTarget()) return false;
    return await send({}, "check_in", buildCheckIn(monitor, status));
  } catch { return false; }
}
