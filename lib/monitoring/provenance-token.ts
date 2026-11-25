import { createHash, timingSafeEqual } from "node:crypto";

// G2-R06 (F-06): constant-time SHA-256 comparison and minimum length policy for STAGING_PROVENANCE_TOKEN,
// aligned with lib/monitoring/readiness.ts (monitoringTokenAccepted).
export const PROVENANCE_TOKEN_HEADER = "x-luxia-provenance-token";
export const MIN_PROVENANCE_TOKEN_LENGTH = 32;

export function provenanceTokenAccepted(
  presented: string | null,
  configured: string | undefined = process.env.STAGING_PROVENANCE_TOKEN,
): boolean {
  if (!configured || configured.length < MIN_PROVENANCE_TOKEN_LENGTH || !presented) {
    return false;
  }
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(presented), digest(configured));
}
