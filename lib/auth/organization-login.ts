import { randomBytes, randomUUID } from "node:crypto";
import { rawPrisma } from "../db/raw-prisma";
import { withTenantDb } from "../db/scoped-client";

// Customer Self-Onboarding v1, requirements 2, 14 and 15. The server resolves the organization,
// tenant and sign-in connection from the organization identifier (slug) itself. Nothing about the
// organization is ever returned before authentication, and no connection is ever picked globally
// or as a "first result": zero or several candidates means no method (fail closed).

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin", "administrator", "api", "app", "auth", "billing", "dashboard", "docs", "help", "invitation",
  "invite", "legal", "login", "logout", "luxia", "luxia-identity", "me", "oauth", "onboarding", "org",
  "organization", "root", "security", "settings", "signup", "sso", "static", "status", "support",
  "system", "www",
]);

/** Trimmed, lower-cased, format-checked organization identifier, or null. */
export function normalizeOrganizationSlug(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const slug = input.trim().toLowerCase();
  if (!SLUG.test(slug) || slug.includes("--") || RESERVED_SLUGS.has(slug)) return null;
  return slug;
}

/** Local identifiers are compared trimmed and lower-cased (as stored by the local provider). */
export function normalizePrincipalName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  return value.length >= 1 && value.length <= 254 ? value : null;
}

export type LoginOrganization = {
  organizationId: string;
  tenantId: string;
  entraConnectionId: string | null;
  localConnectionId: string | null;
};

export async function resolveLoginOrganization(slug: string): Promise<LoginOrganization | null> {
  const organization = await rawPrisma.organization.findUnique({ where: { slug }, select: { id: true } });
  if (!organization) return null;
  // v1 creates exactly one tenant per organization; anything else is ambiguous and refused.
  const tenants = await rawPrisma.tenant.findMany({ where: { organizationId: organization.id }, select: { id: true }, take: 2 });
  if (tenants.length !== 1) return null;
  const scope = { organizationId: organization.id, tenantId: tenants[0].id };
  const connections = await withTenantDb(scope, (tx) => tx.providerConnection.findMany({
    where: {
      organizationId: organization.id,
      providerType: { in: ["MICROSOFT_ENTRA", "LUXIA_LOCAL"] },
      tenantScopes: { some: { organizationId: organization.id, tenantId: scope.tenantId } },
    },
    select: { id: true, providerType: true },
  }));
  const only = (type: string) => {
    const matches = connections.filter((item) => item.providerType === type);
    return matches.length === 1 ? matches[0].id : null;
  };
  return { ...scope, entraConnectionId: only("MICROSOFT_ENTRA"), localConnectionId: only("LUXIA_LOCAL") };
}

/**
 * Passkey sign-in begin answer when no sign-in can start: unknown organization or person, locked or
 * passkey-less identity. Identical in form to a real answer. Credential IDs are never sent before
 * verification: allowCredentials is always empty (discoverable passkeys), so nothing in the answer
 * depends on whether the person exists (finding F1, multi-organization certification 2026-10-11).
 */
export function anonymousPasskeyChallenge(rpId: string) {
  return { transactionId: randomUUID(), challenge: randomBytes(32).toString("base64url"), allowCredentials: [] as string[], rpId };
}

/** Pads a pre-authentication answer to a minimum duration so known and unknown paths take comparable time. */
export async function withMinimumDuration<T>(startedAt: number, minimumMs: number, value: T): Promise<T> {
  const remaining = minimumMs - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  return value;
}

/** Same-origin relative path only (no scheme, no protocol-relative or backslash tricks). */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/dashboard";
  return value;
}
