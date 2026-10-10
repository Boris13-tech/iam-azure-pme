import { NextResponse } from "next/server";
import { beginEntraAuthentication } from "../../../lib/auth/providers/entra";
import { AuthTransactionStore } from "../../../lib/auth/auth-transaction-store";
import { rawPrisma } from "../../../lib/db/raw-prisma";
import { normalizeOrganizationSlug, resolveLoginOrganization, safeReturnTo } from "../../../lib/auth/organization-login";
import { allowRequest, clientNetworkKey } from "../../../lib/security/rate-limit";

export const runtime = "nodejs";

// Microsoft sign-in for one organization, resolved on the server from its identifier (slug).
// Unknown organization, organization without exactly one Microsoft connection, or a rate-limited
// client: the same generic return to the login page. A known organization with Microsoft redirects
// to Microsoft (home-realm discovery, accepted residual risk); no organization data is shown.
const back = (request: Request, error: string) => NextResponse.redirect(new URL(`/login?error=${error}`, request.url), 303);

export async function GET(request: Request) {
  try {
    if (!await allowRequest("login-entra", clientNetworkKey(request))) return back(request, "rate_limited");
    const { searchParams } = new URL(request.url);
    const slug = normalizeOrganizationSlug(searchParams.get("org"));
    const returnTo = safeReturnTo(searchParams.get("returnTo"));
    const organization = slug ? await resolveLoginOrganization(slug) : null;
    if (!organization?.entraConnectionId) return back(request, "signin");

    const provider = await rawPrisma.providerConnection.findUnique({ where: { id: organization.entraConnectionId } });
    if (!provider || provider.organizationId !== organization.organizationId || provider.providerType !== "MICROSOFT_ENTRA")
      return back(request, "signin");

    // Build the provider request behind the adapter boundary.
    const challenge = await beginEntraAuthentication({
      providerConnection: provider,
      tenantId: organization.tenantId,
      returnTo,
    });
    const state = challenge.transactionId;
    const nonce = challenge.continuation?.nonce;
    const codeVerifier = challenge.continuation?.codeVerifier;
    if (!challenge.redirectUrl || !nonce || !codeVerifier) {
      throw new Error("Invalid Microsoft Entra authentication challenge");
    }

    // Persist the auth transaction securely.
    await AuthTransactionStore.createTransaction({
      stateHash: state,
      nonce,
      codeVerifier,
      expectedOrganizationId: provider.organizationId,
      expectedTenantId: organization.tenantId,
      expectedProviderConnectionId: provider.id,
      returnTo,
      expiresInMinutes: 10
    });

    // Redirect to the URL validated and produced by the adapter.
    return NextResponse.redirect(challenge.redirectUrl);
  } catch {
    console.error("ENTRA_LOGIN_BEGIN_FAILED");
    return back(request, "unavailable");
  }
}
