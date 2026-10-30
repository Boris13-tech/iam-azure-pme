import { randomBytes } from "node:crypto";
import { addVirtualAuthenticator } from "./support/virtual-authenticator";
import { MESSAGE, expect, freshOrganization, navigationEntries, newDevice, signInWithPasskey, signUpThroughUi, test, pageAlert, topBar } from "./support/journeys";

// Journey 4: an administrator creates a MEMBER invitation on the Organization page; the link is shown
// once. The invitee opens it in another browser (own context and passkey device), creates a passkey,
// signs in, and sees no administration entry; the server refuses the administration data as well.
const ADMIN_ONLY = ["Identités", "Organisation", "Authentification", "Ressources", "Séparation des tâches", "Revues d’accès", "Journal d’audit"];

test("an invited member joins with a passkey and has no administration access", async ({ page, browser }) => {
  await addVirtualAuthenticator(page);
  const organization = freshOrganization("invite");
  await signUpThroughUi(page, organization);
  await signInWithPasskey(page, organization.slug, organization.principalName);
  expect(await navigationEntries(page)).toEqual(expect.arrayContaining(["Vue d’ensemble", ...ADMIN_ONLY]));

  await page.goto("/dashboard/organization");
  const memberName = `Membre E2E ${randomBytes(2).toString("hex")}`;
  await page.getByLabel("Nom de la personne", { exact: true }).fill(memberName);
  await page.getByLabel("Rôle", { exact: true }).selectOption("MEMBER");
  await page.getByRole("button", { name: "Créer l’invitation" }).click();
  await expect(page.getByText("Ce lien n’est affiché qu’une fois.")).toBeVisible();
  const link = (await page.locator("p.font-mono").filter({ hasText: "/invitation#" }).innerText()).trim();
  expect(link).toMatch(/^http:\/\/localhost:\d+\/invitation#[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText(`${memberName} (Membre)`)).toBeVisible();

  // The invitee, in a fresh browser with its own passkey device.
  const invitee = await newDevice(browser);
  try {
    const principalName = `member-${randomBytes(4).toString("hex")}@example.test`;
    await invitee.page.goto(link);
    await expect(invitee.page).toHaveURL(/\/invitation$/); // the token leaves the address bar
    await invitee.page.getByLabel("Choisissez votre identifiant", { exact: true }).fill(principalName);
    await invitee.page.getByRole("button", { name: "Créer ma clé d’accès et rejoindre l’organisation" }).click();
    await expect(invitee.page.getByText("Votre compte est activé.")).toBeVisible();
    expect(await invitee.authenticator.credentials()).toHaveLength(1);

    await signInWithPasskey(invitee.page, organization.slug, principalName);
    await expect(topBar(invitee.page)).toContainText(memberName);
    expect(await navigationEntries(invitee.page)).toEqual(["Vue d’ensemble"]);

    // Hidden is not the control: the server refuses the administration data to this member.
    expect((await invitee.page.request.get("/api/onboarding/invitations")).status()).toBe(403);
    await invitee.page.goto("/dashboard/organization");
    await expect(invitee.page.getByText("Accès restreint.").first()).toBeVisible();
  } finally {
    await invitee.context.close();
  }

  // The link worked once: a third browser gets the fixed invalid-link message.
  const late = await newDevice(browser);
  try {
    await late.page.goto(link);
    await late.page.getByLabel("Choisissez votre identifiant", { exact: true }).fill(`late-${randomBytes(4).toString("hex")}@example.test`);
    await late.page.getByRole("button", { name: "Créer ma clé d’accès et rejoindre l’organisation" }).click();
    await expect(pageAlert(late.page)).toHaveText(MESSAGE.invitationInvalid);
    expect(await late.authenticator.credentials()).toHaveLength(0);
  } finally {
    await late.context.close();
  }

  await page.reload();
  await expect(page.getByText(`${memberName} (Membre)`)).toBeVisible();
  await expect(page.getByText(/^Acceptée le /)).toBeVisible();
});
