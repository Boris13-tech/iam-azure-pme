import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "../../middleware";
import {
  PERMISSIONS_POLICY_VALUE,
  buildContentSecurityPolicy,
  generateCspNonce,
} from "../../lib/security/http-headers";

const root = join(__dirname, "../..");

function tsxFiles(dir: string): string[] {
  const full = join(root, dir);
  return readdirSync(full).flatMap((name) => {
    const child = join(full, name);
    if (statSync(child).isDirectory()) return tsxFiles(relative(root, child));
    return name.endsWith(".tsx") ? [relative(root, child).replace(/\\/g, "/")] : [];
  });
}

describe("G2-R03 (F-03): HTTP security headers and strict nonce-based CSP", () => {
  it("generates unique 128-bit base64 nonces matching Next.js 15 CSP nonce format", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const nonce = generateCspNonce();
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      seen.add(nonce);
    }
    expect(seen.size).toBe(64);
  });

  it("forbids 'unsafe-inline' and 'unsafe-eval' across every Production CSP directive while preserving WebAuthn & Entra OIDC", () => {
    const nonce = generateCspNonce();
    const csp = buildContentSecurityPolicy({ nonce, isDevelopment: false, isHttps: true });

    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).toContain(`style-src 'self' 'nonce-${nonce}'`);
    expect(csp).toContain(`style-src-elem 'self' 'nonce-${nonce}'`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self' https://login.microsoftonline.com");
    expect(csp).toContain("upgrade-insecure-requests");

    // Local plain-HTTP E2E runs must not emit upgrade-insecure-requests (would break http://localhost:3200).
    const httpLocalCsp = buildContentSecurityPolicy({ nonce, isDevelopment: false, isHttps: false });
    expect(httpLocalCsp).not.toContain("upgrade-insecure-requests");
  });

  it("stamps all security headers and forwards a fresh nonce on public pages, API 401s, redirects, and monitoring routes", () => {
    const loginRes = middleware(new NextRequest("https://iam-azure-pme.vercel.app/login"));
    expect(loginRes.headers.get("x-middleware-next")).toBe("1");
    expect(loginRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(loginRes.headers.get("x-frame-options")).toBe("DENY");
    expect(loginRes.headers.get("referrer-policy")).toBe("same-origin");
    expect(loginRes.headers.get("permissions-policy")).toBe(PERMISSIONS_POLICY_VALUE);
    expect(loginRes.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(loginRes.headers.get("x-dns-prefetch-control")).toBe("off");

    const loginCsp = loginRes.headers.get("content-security-policy") ?? "";
    const forwardedNonce = loginRes.headers.get("x-middleware-override-headers")?.includes("x-nonce")
      ? loginRes.headers.get("x-middleware-request-x-nonce")
      : null;
    expect(forwardedNonce).toBeTruthy();
    expect(loginCsp).toContain(`'nonce-${forwardedNonce}'`);
    expect(loginCsp).not.toContain("'unsafe-inline'");

    // Protected API without session -> 401 still carries full security headers and a distinct nonce.
    const unauthApi = middleware(new NextRequest("https://iam-azure-pme.vercel.app/api/canonical/subjects"));
    expect(unauthApi.status).toBe(401);
    expect(unauthApi.headers.get("x-frame-options")).toBe("DENY");
    expect(unauthApi.headers.get("x-content-type-options")).toBe("nosniff");
    expect(unauthApi.headers.get("content-security-policy")).not.toBe(loginCsp);

    // Protected dashboard without session -> redirect to /login still carries full security headers.
    const unauthDash = middleware(new NextRequest("https://iam-azure-pme.vercel.app/dashboard"));
    expect(unauthDash.status).toBe(307);
    expect(unauthDash.headers.get("location")).toBe("https://iam-azure-pme.vercel.app/login");
    expect(unauthDash.headers.get("x-frame-options")).toBe("DENY");
  });

  it("keeps zero inline style={{...}} attributes in app/ and components/ TSX sources so strict CSP never breaks UI styling", () => {
    const offenders: string[] = [];
    for (const file of [...tsxFiles("app"), ...tsxFiles("components")]) {
      const content = readFileSync(join(root, file), "utf8");
      if (/\bstyle=\{\{/.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
