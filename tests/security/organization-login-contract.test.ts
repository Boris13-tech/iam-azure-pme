import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESERVED_SLUGS, normalizeOrganizationSlug, normalizePrincipalName, safeReturnTo } from "../../lib/auth/organization-login";

// Customer Self-Onboarding v1, step 2 (requirements 2, 4, 14, 15): contract checks that need no database.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("Organization-aware sign-in contract", () => {
  it("organization identifiers are normalized, bounded and never reserved words", () => {
    expect(normalizeOrganizationSlug("  Legrand-Tech ")).toBe("legrand-tech");
    for (const bad of ["ab", "a".repeat(41), "-start", "end-", "double--dash", "spaces here", "accént", "admin", "LOGIN", 42, null, undefined])
      expect(normalizeOrganizationSlug(bad), String(bad)).toBeNull();
    expect(normalizeOrganizationSlug("a".repeat(40))).toBe("a".repeat(40));
    expect(RESERVED_SLUGS.has("legrand-tech")).toBe(false);
    expect(normalizePrincipalName("  Alice ")).toBe("alice");
    expect(normalizePrincipalName("x".repeat(255))).toBeNull();
  });

  it("returnTo accepts same-origin paths only", () => {
    for (const bad of [null, "", "https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) expect(safeReturnTo(bad)).toBe("/dashboard");
    expect(safeReturnTo("/dashboard/audit?x=1")).toBe("/dashboard/audit?x=1");
  });

  it("the login page reads nothing from the database and echoes no URL text", () => {
    const page = readFileSync("app/login/page.tsx", "utf8");
    expect(page).not.toMatch(/prisma|findFirst|providerConnection/i);
    expect(page).toMatch(/ERRORS\[sp\.error\]/);
    const client = readFileSync("app/login/local-passkey-login.tsx", "utf8");
    expect(client).toContain("JSON.stringify({ organization, principalName })");
    expect(client).not.toMatch(/providerConnectionId|tenantId|externalObjectId/);
  });

  it("sign-in routes never take a tenant or connection from the browser", () => {
    const beginRoute = readFileSync("app/api/auth/local/begin/route.ts", "utf8");
    const completeRoute = readFileSync("app/api/auth/local/complete/route.ts", "utf8");
    const entra = readFileSync("app/auth/login/route.ts", "utf8");
    for (const source of [beginRoute, completeRoute]) {
      expect(source).toContain("resolveLoginOrganization(slug)");
      expect(source).not.toMatch(/body\??\.(providerConnectionId|tenantId|externalObjectId)|field\("(providerConnectionId|tenantId|externalObjectId)"\)/);
      expect(source).toContain('allowRequest("login-');
    }
    expect(entra).toContain("resolveLoginOrganization(slug)");
    expect(entra).not.toMatch(/searchParams\.get\("(tenant|connection)"\)/);
    expect(entra).toContain("safeReturnTo(");
  });

  it("finding F1: passkey begin never lists credential IDs; every registration asks for a discoverable passkey", () => {
    const beginRoute = readFileSync("app/api/auth/local/begin/route.ts", "utf8");
    expect(beginRoute).toContain("allowCredentials: [] as string[]");
    expect(beginRoute).not.toMatch(/credentialId: true|\.credentialId\)/);
    const lib = readFileSync("lib/auth/organization-login.ts", "utf8");
    expect(lib).not.toMatch(/luxia_login_decoy|decoyPasskeyChallenge/);
    for (const client of ["app/dashboard/settings/passkey-enrollment.tsx", "app/signup/signup-form.tsx", "app/invitation/accept-invitation.tsx"])
      expect(readFileSync(client, "utf8"), client).toContain('residentKey: "required"');
  });

  it("requirement 14: no provider connection is chosen globally or as a first result anywhere in the application", () => {
    for (const file of [...sources("app"), ...sources("lib")]) {
      const source = readFileSync(file, "utf8");
      // A providerConnection lookup must always be bound to an id or an organization.
      for (const match of source.matchAll(/providerConnection\.(findFirst|findMany)\(\{([\s\S]{0,400})/g)) {
        expect(match[2], file).toMatch(/\bid\b|organizationId/);
      }
      expect(source, file).not.toMatch(/providerConnection\.findFirst\(\{[^)]*orderBy/);
    }
  });
});
