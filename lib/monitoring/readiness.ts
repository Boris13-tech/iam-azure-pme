import { createHash, timingSafeEqual } from "node:crypto";
import { rawPrisma } from "../db/raw-prisma";

// Minimum application monitoring, slice 1 (docs/operations/MINIMUM-APPLICATION-MONITORING-DESIGN.md, M-B).
// Database readiness for the external monitor only: token-protected, cached, single flight, generic answers.

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

type Check = () => Promise<unknown>;
const databaseCheck: Check = () => rawPrisma.$queryRaw`SELECT 1`;

let cached: { at: number; ready: boolean } | null = null;
let inflight: Promise<boolean> | null = null;
// A query that outlived its timeout: it cannot be cancelled, so no other starts until it settles.
let outstanding = false;

/** Resets the cache (tests only). */
export function resetReadinessCache() { cached = null; inflight = null; outstanding = false; }

/**
 * Whether the database answers within the timeout. Whatever the call rate, the database sees at most one
 * check per cache period per instance: concurrent callers share the check in flight, later ones the cache. A stalled
 * database holds at most one query: while one is unanswered the answer is not ready, and no new query starts.
 */
export async function databaseReady(check: Check = databaseCheck, now = Date.now()): Promise<boolean> {
  if (cached && now - cached.at < READINESS_CACHE_MS) return cached.ready;
  if (inflight) return inflight;
  if (outstanding) return false;
  inflight = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      outstanding = true;
      const query = check();
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
}
