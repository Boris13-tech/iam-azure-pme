import { addVirtualAuthenticator } from "./support/virtual-authenticator";
import { expect, freshOrganization, signInWithPasskey, signOut, signUpThroughUi, test, topBar } from "./support/journeys";

// Journey 2: passkey sign-in on /login (organization identifier + personal identifier) -> /dashboard;
// sign-out (POST /auth/logout) -> /login, the session is gone and /dashboard sends back to /login.
test("the founder signs in with the passkey, signs out, and the dashboard is closed again", async ({ page, context }) => {
  await addVirtualAuthenticator(page);
  const organization = freshOrganization("signin");
  await signUpThroughUi(page, organization);

  await signInWithPasskey(page, organization.slug, organization.principalName);
  await expect(topBar(page)).toContainText(organization.organizationName);
  const session = (await context.cookies()).find((cookie) => cookie.name === "luxia_session");
  expect(session).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
  expect(session?.value).toBeTruthy();

  await signOut(page);
  await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
  expect((await context.cookies()).some((cookie) => cookie.name === "luxia_session" && cookie.value)).toBe(false);

  await page.goto("/dashboard");
  await page.waitForURL("**/login");
  // The revoked token is refused by the server too, not only absent from the browser (review of #141): it is put back
  // as a cookie valid for an hour, the request is shown to carry it, and the server still sends back to /login.
  await context.addCookies([{ ...session!, expires: Math.floor(Date.now() / 1000) + 3600 }]);
  const sent = page.waitForRequest((request) => new URL(request.url()).pathname === "/dashboard");
  await page.goto("/dashboard");
  expect((await (await sent).allHeaders()).cookie ?? "").toContain(`luxia_session=${session!.value}`);
  await page.waitForURL("**/login");
});
