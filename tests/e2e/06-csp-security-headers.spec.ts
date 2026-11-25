import { addVirtualAuthenticator } from "./support/virtual-authenticator";
import { expect, freshOrganization, signInWithPasskey, signOut, signUpThroughUi, test } from "./support/journeys";

// G2-R03 (F-03): end-to-end proof in real headless Chromium against a production Next.js build (`next build && next start`)
// that strict nonce-based CSP (zero 'unsafe-inline', zero 'unsafe-eval') and Permissions-Policy work seamlessly across
// passkey registration (/signup), passkey authentication (/login), Entra OIDC form markup, /dashboard, /dashboard/settings,
// and /auth/logout with zero SecurityPolicyViolationEvent and zero uncaught page errors.
test("strict nonce CSP emits zero violations across WebAuthn passkey signup, sign-in, dashboard, and logout", async ({ page }) => {
  const cspViolations: string[] = [];
  const pageErrors: string[] = [];

  await page.exposeFunction("__recordCspViolation", (detail: string) => {
    cspViolations.push(detail);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const record = (window as unknown as { __recordCspViolation?: (d: string) => void }).__recordCspViolation;
      record?.(`${event.violatedDirective} -> ${event.blockedURI || "inline"}`);
    });
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await addVirtualAuthenticator(page);
  const organization = freshOrganization("csp");

  const firstNav = await page.goto("/login");
  expect(firstNav).not.toBeNull();
  const headers1 = firstNav!.headers();
  const csp1 = headers1["content-security-policy"] ?? "";
  expect(csp1).not.toContain("'unsafe-inline'");
  expect(csp1).not.toContain("'unsafe-eval'");
  expect(csp1).toContain("'strict-dynamic'");
  expect(csp1).toContain("frame-ancestors 'none'");
  expect(csp1).toContain("form-action 'self' https://login.microsoftonline.com");
  expect(headers1["x-content-type-options"]).toBe("nosniff");
  expect(headers1["x-frame-options"]).toBe("DENY");
  expect(headers1["referrer-policy"]).toBe("same-origin");
  expect(headers1["permissions-policy"]).toContain("publickey-credentials-get=(self)");
  expect(headers1["permissions-policy"]).toContain("publickey-credentials-create=(self)");
  expect(headers1["x-powered-by"]).toBeUndefined();

  const nonceMatch1 = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp1);
  expect(nonceMatch1?.[1]).toBeTruthy();

  // Second navigation must rotate the cryptographic nonce.
  const secondNav = await page.goto("/signup");
  const csp2 = secondNav!.headers()["content-security-policy"] ?? "";
  const nonceMatch2 = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp2);
  expect(nonceMatch2?.[1]).toBeTruthy();
  expect(nonceMatch2?.[1]).not.toBe(nonceMatch1?.[1]);

  // Every inline <script> in the rendered document carries the server's nonce attribute (hydrated by Chromium,
  // which strips the DOM attribute value for security while exposing script.nonce !== "" or nonced execution).
  await signUpThroughUi(page, organization);
  await signInWithPasskey(page, organization.slug, organization.principalName);
  await page.goto("/dashboard/settings");
  await expect(page.getByRole("heading", { name: "Authentification", exact: true })).toBeVisible();
  await signOut(page);

  // Unknown route renders custom 404 without inline style CSP violations.
  const notFound = await page.goto("/route-inexistante-csp-check");
  expect(notFound?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page introuvable" })).toBeVisible();

  expect(cspViolations).toEqual([]);
  expect(pageErrors).toEqual([]);
});
