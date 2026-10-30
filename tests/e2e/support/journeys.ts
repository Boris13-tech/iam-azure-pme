import { randomBytes } from "node:crypto";
import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { issueSignupCode } from "./local-db";
import { addVirtualAuthenticator, type VirtualAuthenticator } from "./virtual-authenticator";

// Shared steps of the passkey journeys, all through the real pages (labels and buttons a person sees).
//
// Client network: the server rate-limits per client address (lib/security/rate-limit.ts), read from
// x-real-ip, which Vercel sets in Production. Locally there is no proxy, so every journey would share
// one counter and a few runs per hour would exhaust the signup limit (10 per hour). Each test, and each
// extra device, therefore presents its own address from the IPv6 documentation range (2001:db8::/32),
// like distinct people on distinct networks. The limits themselves are unchanged and still apply.

/** Fixed messages of the pages (copied from the components, so a wording change fails loudly). */
export const MESSAGE = {
  signInRefused: "Connexion refusée. Vérifiez l’identifiant de l’organisation et votre identifiant.",
  ceremonyCancelled: "La vérification a été annulée, a expiré, ou aucune clé d’accès ne correspond.",
  recoveryRefused: "Connexion refusée. Vérifiez l’identifiant de l’organisation, votre identifiant et le code. Après plusieurs essais, patientez une heure.",
  invitationInvalid: "Ce lien d’invitation n’est pas valide, a expiré, a été révoqué ou a déjà été utilisé. Demandez un nouveau lien à votre administrateur.",
} as const;

/**
 * The page's own alert. Next.js also renders a route announcer with role="alert" (#__next-route-announcer__,
 * empty, for screen readers on navigation); it is excluded by its fixed id, not by position.
 */
export const pageAlert = (page: Page) => page.getByRole("alert").and(page.locator(":not(#__next-route-announcer__)"));

/** The signed-in frame's top bar (organization, environment, person): the one <header> with this role in the layout. */
export const topBar = (page: Page) => page.locator("header.luxia-topbar");

export const newClientAddress = () => `2001:db8:${randomBytes(2).toString("hex")}::${randomBytes(2).toString("hex")}`;

export const test = base.extend<{ clientAddress: string }>({
  clientAddress: async ({}, use) => { await use(newClientAddress()); },
  extraHTTPHeaders: async ({ clientAddress }, use) => { await use({ "x-real-ip": clientAddress }); },
});
export { expect };

/** Another person's browser: its own context (cookies, storage), network address and passkey device. */
export async function newDevice(browser: Browser): Promise<{ context: BrowserContext; page: Page; authenticator: VirtualAuthenticator }> {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": newClientAddress() } });
  const page = await context.newPage();
  return { context, page, authenticator: await addVirtualAuthenticator(page) };
}

export type Organization = { slug: string; organizationName: string; founderName: string; principalName: string };

/** Fresh names for one journey: nothing is shared between tests. */
export function freshOrganization(label: string): Organization {
  const id = randomBytes(4).toString("hex");
  return { slug: `e2e-${label}-${id}`, organizationName: `E2E ${label} ${id}`, founderName: "Fondatrice E2E", principalName: `founder-${id}@example.test` };
}

/** /signup with a freshly issued operator code; the page's virtual authenticator creates the passkey. Returns the code. */
export async function signUpThroughUi(page: Page, organization: Organization): Promise<string> {
  const code = await issueSignupCode();
  await fillSignupForm(page, code, organization);
  await expect(page.getByText("Organisation créée.")).toBeVisible();
  return code;
}

export async function fillSignupForm(page: Page, code: string, organization: Organization): Promise<void> {
  await page.goto("/signup");
  await page.getByLabel("Code d’accès bêta", { exact: true }).fill(code);
  await page.getByLabel("Nom de l’organisation", { exact: true }).fill(organization.organizationName);
  await page.getByLabel("Identifiant de l’organisation", { exact: true }).fill(organization.slug);
  await page.getByLabel("Votre nom", { exact: true }).fill(organization.founderName);
  await page.getByLabel("Votre identifiant", { exact: true }).fill(organization.principalName);
  await page.getByRole("button", { name: "Créer l’organisation et ma clé d’accès" }).click();
}

/** Fills /login and starts the passkey ceremony; does not wait for the outcome. */
export async function startPasskeySignIn(page: Page, organization: string, principalName: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Identifiant de l’organisation", { exact: true }).fill(organization);
  await page.getByLabel("Votre identifiant", { exact: true }).fill(principalName);
  await page.getByRole("button", { name: "Se connecter avec une clé d’accès" }).click();
}

export async function signInWithPasskey(page: Page, organization: string, principalName: string): Promise<void> {
  await startPasskeySignIn(page, organization, principalName);
  await page.waitForURL("**/dashboard");
  await expect(page.getByRole("heading", { name: "Vue d’ensemble" })).toBeVisible();
}

/** Same message for every refusal; the person stays on /login without a session. */
export async function expectSignInRefused(page: Page, message: string): Promise<void> {
  await expect(page.getByRole("status")).toHaveText(message);
  expect(new URL(page.url()).pathname).toBe("/login");
  expect((await page.context().cookies()).some((cookie) => cookie.name === "luxia_session" && cookie.value)).toBe(false);
}

/** The sidebar button (POST /auth/logout, Origin checked by the server). */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await page.waitForURL("**/login");
}

export async function navigationEntries(page: Page): Promise<string[]> {
  return (await page.getByRole("navigation", { name: "Navigation principale" }).getByRole("link").allInnerTexts()).map((text) => text.trim());
}
