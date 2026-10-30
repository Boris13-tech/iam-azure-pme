import { addVirtualAuthenticator } from "./support/virtual-authenticator";
import {
  MESSAGE, expect, expectSignInRefused, freshOrganization, signInWithPasskey, signOut, signUpThroughUi, startPasskeySignIn, test,
} from "./support/journeys";

// Journey 3: recovery codes generated in Settings -> the device is lost -> /login/recovery with one code
// -> recovery-only session on /recovery (nothing else is open) -> a new passkey on a NEW device ->
// sign-in with it. The old passkey, presented again from a copy of the lost device, is refused.
test("a recovery code replaces a lost passkey and the old passkey is refused afterwards", async ({ page }) => {
  const lostDevice = await addVirtualAuthenticator(page);
  const organization = freshOrganization("recovery");
  await signUpThroughUi(page, organization);
  await signInWithPasskey(page, organization.slug, organization.principalName);

  // Settings: a batch is shown once; keep one code as the person would write it down.
  await page.goto("/dashboard/settings");
  const section = page.locator("#codes-de-recuperation");
  await section.getByRole("button", { name: "Générer 10 codes" }).click();
  const codes = section.locator("ol li");
  await expect(codes).toHaveCount(10);
  const code = (await codes.first().innerText()).trim();
  expect(code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
  await section.getByRole("button", { name: "J’ai enregistré mes codes" }).click();
  await expect(section).toContainText("10 codes restants.");
  await signOut(page);

  // The device is lost: keep a copy of its credential to replay later, then remove it from the browser.
  const oldCredentials = await lostDevice.credentials();
  expect(oldCredentials).toHaveLength(1);
  await lostDevice.remove();

  await page.goto("/login/recovery");
  await expect(page.getByLabel("Identifiant de l’organisation", { exact: true })).toHaveValue(organization.slug); // remembered in this browser
  await page.getByLabel("Votre identifiant", { exact: true }).fill(organization.principalName);
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Utiliser ce code" }).click();
  await page.waitForURL("**/recovery");
  await expect(page.getByRole("heading", { name: "Récupération de votre compte" })).toBeVisible();

  // Recovery-only: the dashboard and the APIs refuse this session.
  expect((await page.request.get("/api/me/recovery-codes")).status()).toBe(401);
  await page.goto("/dashboard");
  await page.waitForURL("**/login");
  await page.goto("/recovery");
  await expect(page.getByRole("heading", { name: "Récupération de votre compte" })).toBeVisible();

  const newDevice = await addVirtualAuthenticator(page);
  await page.getByRole("button", { name: "Ajouter une nouvelle clé d’accès" }).click();
  await expect(page.getByText("Votre nouvelle clé d’accès est enregistrée.")).toBeVisible();
  const newCredentials = await newDevice.credentials();
  expect(newCredentials).toHaveLength(1);
  expect(newCredentials[0].credentialId).not.toBe(oldCredentials[0].credentialId);

  // The same code cannot open a second recovery session.
  await page.goto("/login/recovery");
  await page.getByLabel("Votre identifiant", { exact: true }).fill(organization.principalName);
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Utiliser ce code" }).click();
  await expect(page.getByRole("alert")).toHaveText(MESSAGE.recoveryRefused);

  // The new passkey signs in (FULL session), and the R5 notice asks for a new batch.
  await signInWithPasskey(page, organization.slug, organization.principalName);
  await expect(page.getByText("Vous avez utilisé un code de récupération.", { exact: false })).toBeVisible();
  await signOut(page);

  // The lost device turns up again: its passkey is refused like any unknown key.
  await newDevice.remove();
  const foundDevice = await addVirtualAuthenticator(page);
  await foundDevice.addCredential(oldCredentials[0]);
  await startPasskeySignIn(page, organization.slug, organization.principalName);
  await expectSignInRefused(page, MESSAGE.signInRefused);
});
