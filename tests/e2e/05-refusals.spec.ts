import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { addVirtualAuthenticator } from "./support/virtual-authenticator";
import {
  MESSAGE, expect, expectSignInRefused, freshOrganization, signInWithPasskey, signUpThroughUi, startPasskeySignIn, test,
} from "./support/journeys";

// Journey 5: refusals. A wrong organization identifier and an unknown person get the same fixed message
// as each other, after the same form of server answer, so the page never reveals whether an organization
// exists. A cancelled ceremony (user verification failed, or no passkey on the device) gets its own fixed
// message and opens no session. The device always holds a real passkey of this site while it is refused.

/** Starts a sign-in and returns the keys and status of the begin answer the browser received. */
async function beginShape(page: Page, organization: string, principalName: string) {
  const answer = page.waitForResponse((response) => response.url().endsWith("/api/auth/local/begin"));
  await startPasskeySignIn(page, organization, principalName);
  const response = await answer;
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status(), keys: Object.keys(body).sort(), allowCredentials: body.allowCredentials };
}

test("wrong organization, unknown person and cancelled ceremonies are refused with fixed messages", async ({ page }) => {
  const device = await addVirtualAuthenticator(page);
  const organization = freshOrganization("refusal");
  await signUpThroughUi(page, organization);
  const absent = `e2e-absent-${randomBytes(4).toString("hex")}`;
  const stranger = `nobody-${randomBytes(4).toString("hex")}@example.test`;

  // Wrong organization identifier (well formed, does not exist), with the right person.
  const wrongOrganization = await beginShape(page, absent, organization.principalName);
  await expectSignInRefused(page, MESSAGE.signInRefused);
  // Existing organization, unknown person.
  const unknownPerson = await beginShape(page, organization.slug, stranger);
  await expectSignInRefused(page, MESSAGE.signInRefused);
  // The real person, for comparison of the answer's form only.
  const known = await beginShape(page, organization.slug, organization.principalName);
  await page.waitForURL("**/dashboard");
  await page.context().clearCookies();

  for (const shape of [wrongOrganization, unknownPerson]) expect(shape).toEqual(known);
  expect(known).toEqual({ status: 200, keys: ["allowCredentials", "challenge", "rpId", "transactionId"], allowCredentials: [] });

  // Nothing about the organization appears on the refused page.
  await startPasskeySignIn(page, absent, organization.principalName);
  await expectSignInRefused(page, MESSAGE.signInRefused);
  await expect(page.locator("body")).not.toContainText(organization.organizationName);

  // Cancelled ceremony 1: the device cannot verify the user (user verification is required).
  await device.setUserVerified(false);
  await startPasskeySignIn(page, organization.slug, organization.principalName);
  await expectSignInRefused(page, MESSAGE.ceremonyCancelled);
  await device.setUserVerified(true);

  // Cancelled ceremony 2: the passkey is no longer on the device.
  const saved = await device.credentials();
  await device.clearCredentials();
  await startPasskeySignIn(page, organization.slug, organization.principalName);
  await expectSignInRefused(page, MESSAGE.ceremonyCancelled);

  // The same key, back on the device, still signs in: the refusals locked nothing.
  await device.addCredential(saved[0]);
  await signInWithPasskey(page, organization.slug, organization.principalName);
  await page.context().clearCookies();

  // Recovery sign-in: unknown organization and wrong code for a real person get one message.
  for (const [org, person] of [[absent, organization.principalName], [organization.slug, organization.principalName], [organization.slug, stranger]]) {
    await page.goto("/login/recovery");
    await page.getByLabel("Identifiant de l’organisation", { exact: true }).fill(org);
    await page.getByLabel("Votre identifiant", { exact: true }).fill(person);
    await page.getByLabel("Code de récupération", { exact: true }).fill("AAAAA-BBBBB-CCCCC-DDDDD");
    await page.getByRole("button", { name: "Utiliser ce code" }).click();
    await expect(page.getByRole("alert")).toHaveText(MESSAGE.recoveryRefused);
    expect(new URL(page.url()).pathname).toBe("/login/recovery");
  }
});
