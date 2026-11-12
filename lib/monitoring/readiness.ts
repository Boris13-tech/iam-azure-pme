import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rawPrisma } from "../db/raw-prisma";
import { resolveAuthorizationMode } from "../auth/authorization-mode";
import { SessionStore } from "../auth/session-store";

// Minimum application monitoring, slice 1 (docs/operations/MINIMUM-APPLICATION-MONITORING-DESIGN.md, M-B), extended
// for the Production deploy (consolidated review of the Release Candidate, Codex F2): readiness covers what a signed-in
// user needs, not only that the public pages answer. Token-protected, cached, single flight, generic answers.

export const MONITORING_TOKEN_HEADER = "x-luxia-monitoring-token";
export const READINESS_CACHE_MS = 15_000;
export const READINESS_TIMEOUT_MS = 2_000;
const MIN_TOKEN_LENGTH = 32;

/**
 * True only when the configured monitoring token is long enough and the presented one equals it (constant
 * time). A missing or short configuration refuses every caller (fail closed).
 */
export function monitoringTokenAccepted(presented: string | null, configured = process.env.LUXIA_MONITORING_TOKEN): boolean {
  if (!configured || configured.length < MIN_TOKEN_LENGTH || !presented) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(configured));
}

/** The three checks, each true or false: nothing else is ever returned (no error text, no mode, no host). */
export type ReadinessChecks = { authorization: boolean; database: boolean; session: boolean };
export type Readiness = { ready: boolean; checks: ReadinessChecks };

/**
 * The authorization configuration the running process actually resolves. In Production (marked by Vercel or LUXIA),
 * only "native" is ready: the Private Beta runs in native mode, a missing or unknown AUTHZ_MODE refuses every session
 * (authorization-mode.ts), and the shadow modes write to a table whose policy refuses them (private finding,
 * 2026-10-30). Elsewhere any mode that resolves is ready.
 */
export function authorizationReady(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const mode = resolveAuthorizationMode(env);
  const production = env.VERCEL_ENV === "production" || env.APP_ENV === "production";
  return production ? mode === "native" : mode !== null;
}

type Check = () => Promise<unknown>;
const databaseCheck: Check = () => rawPrisma.$queryRaw`SELECT 1`;
/**
 * The real session path, as the runtime role: the canonical resolver with a random token that no session can have. It
 * must answer, and answer nothing. A failing resolver (missing function, revoked grant, broken policy) fails the check.
 */
const sessionCheck: Check = async () => {
  const session = await SessionStore.getSession(randomBytes(32).toString("hex"));
  if (session !== null) throw new Error("READINESS_UNEXPECTED_SESSION");
};

/**
 * One guarded check: whatever the call rate, its dependency sees at most one call per cache period per instance
 * (concurrent callers share the call in flight, later ones the cache). A call that outlived the timeout cannot be
 * cancelled: while it is unanswered the check is not ready and no new call starts.
 */
function guarded() {
  let cached: { at: number; ready: boolean } | null = null;
  let inflight: Promise<boolean> | null = null;
  let outstanding = false;
  const run = async (check: Check, now: number): Promise<boolean> => {
    if (cached && now - cached.at < READINESS_CACHE_MS) return cached.ready;
    if (inflight) return inflight;
    if (outstanding) return false;
    inflight = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const query = check();
        outstanding = true;
        const settled = () => { outstanding = false; };
        query.then(settled, settled);
        await Promise.race([
          query,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("READINESS_TIMEOUT")), READINESS_TIMEOUT_MS); }),
        ]);
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      const ready = await inflight;
      cached = { at: now, ready };
      return ready;
    } finally {
      inflight = null;
    }
  };
  return { run, reset: () => { cached = null; inflight = null; outstanding = false; } };
}

const database = guarded();
const session = guarded();

/** Resets the caches (tests only). */
export function resetReadinessCache() { database.reset(); session.reset(); }

/** Whether the database answers within the timeout (guarded). */
export function databaseReady(check: Check = databaseCheck, now = Date.now()): Promise<boolean> {
  return database.run(check, now);
}

/** Whether the session resolver answers, with no session, within the timeout (guarded). */
export function sessionReady(check: Check = sessionCheck, now = Date.now()): Promise<boolean> {
  return session.run(check, now);
}

/** Ready only when the authorization configuration, the database and the session path all are. */
export async function readiness(env: Readonly<Record<string, string | undefined>> = process.env, now = Date.now()): Promise<Readiness> {
  const authorization = authorizationReady(env);
  const [databaseOk, sessionOk] = await Promise.all([databaseReady(undefined, now), sessionReady(undefined, now)]);
  const checks = { authorization, database: databaseOk, session: sessionOk };
  return { ready: authorization && databaseOk && sessionOk, checks };
}
