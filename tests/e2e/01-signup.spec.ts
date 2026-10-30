import { addVirtualAuthenticator } from "./support/virtual-authenticator";
import { expect, fillSignupForm, freshOrganization, signUpThroughUi, test } from "./support/journeys";

// Journey 1: an operator-issued private-beta code -> /signup -> the founder's passkey is created on the
// device -> success screen -> /login with the organization identifier prefilled. The code is single-use.
test("a private-beta code creates the organization and the founder's passkey, then /login is prefilled", async ({ page }) => {
  const authenticator = await addVirtualAuthenticator(page);
  const organization = freshOrganization("signup");

  const code = await signUpThroughUi(page, organization);
  await expect(page.getByText(organization.slug, { exact: true })).toBeVisible();

  // One discoverable passkey, bound to the RP ID the server derived from the request (localhost).
  const credentials = await authenticator.credentials();
  expect(credentials).toHaveLength(1);
  expect(credentials[0]).toMatchObject({ isResidentCredential: true, rpId: "localhost" });

  await page.locator(`a[href="/login?org=${organization.slug}"]`).click();
  await page.waitForURL(`**/login?org=${organization.slug}`);
  await expect(page.getByLabel("Identifiant de l’organisation", { exact: true })).toHaveValue(organization.slug);

  // The code is spent: a second organization cannot be created with it, and no passkey is made for it.
  await fillSignupForm(page, code, freshOrganization("signup-replay"));
  await expect(page.getByRole("alert")).toHaveText("Ce code n’est pas valide, a expiré ou a déjà été utilisé.");
  expect(await authenticator.credentials()).toHaveLength(1);
});
