import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { withTenantDb } from "../db/scoped-client";
import { CanonicalAdminError } from "../admin/canonical-administration";
import { operation, requireNative } from "../resources/service";
import { allowRequest } from "../security/rate-limit";
import type { AuthContext } from "../auth/authorization-engine";

// Customer Self-Onboarding v1, step 5 (requirements 3, 10, 11). A domain is verified only by a
// random, single-use DNS TXT challenge with an expiry. A typed domain is never trusted. A verified
// domain belongs to one organization at a time (partial unique index); revalidation that no longer
// finds the record marks it LOST and frees it.

export const RECORD_PREFIX = "_luxia-verification";
const VALUE = /^luxia-verification=([A-Za-z0-9_-]{43})$/;
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CHALLENGE_DAYS = 7;
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const context = (auth: AuthContext) => ({ organizationId: auth.organizationId, tenantId: auth.tenantId });

export type TxtResolver = (name: string) => Promise<string[][]>;
const systemResolver = new Resolver({ timeout: 3000, tries: 2 });
const defaultResolver: TxtResolver = (name) => systemResolver.resolveTxt(name);

/** Lower-cased, punycode, no trailing dot, no scheme, port or path. Null if not a domain name. */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().toLowerCase().replace(/\.$/, "");
  if (!raw || /[/:@\s?#\\]/.test(raw)) return null;
  let host: string;
  try { host = new URL(`http://${raw}`).hostname; } catch { return null; }
  return host.length <= 253 && DOMAIN.test(host) ? host : null;
}

const view = (row: { id: string; domain: string; status: string; challengeExpiresAt: Date; verifiedAt: Date | null; lastCheckedAt: Date | null }) => ({
  id: row.id, domain: row.domain, status: row.status, recordName: `${RECORD_PREFIX}.${row.domain}`,
  challengeExpiresAt: row.challengeExpiresAt, verifiedAt: row.verifiedAt, lastCheckedAt: row.lastCheckedAt,
});

export function listDomains(auth: AuthContext, changeId: string) {
  return operation(auth, changeId, "DOMAIN.READ", "providers.read", async (tx) => ({
    value: (await tx.organizationDomain.findMany({ where: context(auth), orderBy: { createdAt: "asc" } })).map(view),
  }));
}

/** Adds a domain, or issues a new challenge for one that is not verified. The value is shown once. */
export function addDomain(auth: AuthContext, changeId: string, input: unknown) {
  return operation(auth, changeId, "DOMAIN.ADD", "providers.manage", async (tx) => {
    const domain = normalizeDomain(input);
    if (!domain) throw new CanonicalAdminError("INVALID_DOMAIN", 400);
    const token = randomBytes(32).toString("base64url");
    const challenge = { challengeHash: sha256Hex(token), challengeExpiresAt: new Date(Date.now() + CHALLENGE_DAYS * 86_400_000), status: "PENDING" as const };
    const existing = await tx.organizationDomain.findFirst({ where: { ...context(auth), domain } });
    if (existing?.status === "VERIFIED") throw new CanonicalAdminError("DOMAIN_ALREADY_VERIFIED", 409);
    const row = existing
      ? await tx.organizationDomain.update({ where: { id: existing.id }, data: { ...challenge, verifiedAt: null } })
      : await tx.organizationDomain.create({ data: { ...context(auth), domain, ...challenge } });
    return { value: { ...view(row), recordValue: `luxia-verification=${token}` }, metadata: { domain, renewed: Boolean(existing) } };
  });
}

/**
 * Checks the TXT record. PENDING: verifies it (or reports why not). VERIFIED: revalidates it and
 * marks it LOST when the record is gone. DNS is queried outside the database transaction.
 */
export async function checkDomain(auth: AuthContext, changeId: string, id: string, resolver: TxtResolver = defaultResolver) {
  const target = await withTenantDb(auth, async (tx) => {
    await requireNative(tx, auth, "providers.manage");
    return tx.organizationDomain.findFirst({ where: { ...context(auth), id } });
  });
  if (!target) throw new CanonicalAdminError("DOMAIN_NOT_FOUND", 404);
  if (!await allowRequest("dns-verify", `org:${auth.organizationId}`)) throw new CanonicalAdminError("RATE_LIMITED", 429);
  let records: string[];
  try {
    records = (await resolver(`${RECORD_PREFIX}.${target.domain}`)).map((chunks) => chunks.join("").trim());
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOTFOUND" && code !== "ENODATA" && code !== "NOTFOUND" && code !== "NODATA") throw new CanonicalAdminError("DNS_UNAVAILABLE", 503);
    records = [];
  }
  return operation(auth, changeId, "DOMAIN.CHECK", "providers.manage", async (tx) => {
    const row = await tx.organizationDomain.findFirst({ where: { ...context(auth), id } });
    if (!row) throw new CanonicalAdminError("DOMAIN_NOT_FOUND", 404);
    const now = new Date();
    const expected = Buffer.from(row.challengeHash, "hex");
    const present = records.some((record) => {
      const match = VALUE.exec(record);
      return Boolean(match) && timingSafeEqual(Buffer.from(sha256Hex(match![1]), "hex"), expected);
    });
    if (row.status === "VERIFIED") {
      if (present) {
        await tx.organizationDomain.update({ where: { id }, data: { lastCheckedAt: now } });
        return { value: view({ ...row, lastCheckedAt: now }), metadata: { domain: row.domain, outcome: "STILL_VERIFIED" } };
      }
      const lost = await tx.organizationDomain.update({ where: { id }, data: { status: "LOST", lastCheckedAt: now } });
      return { value: view(lost), metadata: { domain: row.domain, outcome: "LOST" } };
    }
    if (row.status !== "PENDING") throw new CanonicalAdminError("DOMAIN_CHALLENGE_REQUIRED", 409);
    if (row.challengeExpiresAt <= now) {
      await tx.organizationDomain.update({ where: { id }, data: { status: "EXPIRED", lastCheckedAt: now } });
      throw new CanonicalAdminError("DOMAIN_CHALLENGE_EXPIRED", 409);
    }
    if (!present) {
      await tx.organizationDomain.update({ where: { id }, data: { lastCheckedAt: now } });
      throw new CanonicalAdminError("DOMAIN_RECORD_NOT_FOUND", 409);
    }
    // Global uniqueness (requirement 11) is enforced by the database; a conflict is reported, not hidden.
    await tx.$executeRaw`SAVEPOINT domain_verify`;
    try {
      const verified = await tx.organizationDomain.update({ where: { id }, data: { status: "VERIFIED", verifiedAt: now, lastCheckedAt: now } });
      await tx.$executeRaw`RELEASE SAVEPOINT domain_verify`;
      return { value: view(verified), metadata: { domain: row.domain, outcome: "VERIFIED" } };
    } catch {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT domain_verify`;
      throw new CanonicalAdminError("DOMAIN_VERIFIED_ELSEWHERE", 409);
    }
  });
}
