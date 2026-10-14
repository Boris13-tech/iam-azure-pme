import { NextResponse } from "next/server";
import { beginEntraAuthentication } from "../../../lib/auth/providers/entra";
import { AuthTransactionStore } from "../../../lib/auth/auth-transaction-store";
import { withTenantDb } from "../../../lib/db/scoped-client";
import { normalizeOrganizationSlug, resolveLoginOrganization, safeReturnTo, singleFederationConnection } from "../../../lib/auth/organization-login";
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
    const connectionId = organization ? singleFederationConnection(organization, "MICROSOFT_ENTRA") : null;
    if (!organization || !connectionId) return back(request, "signin");

    // Read inside the organization's scope; only an ACTIVE connection starts a sign-in (F2 kill switch).
    const provider = await withTenantDb({ organizationId: organization.organizationId, tenantId: organization.tenantId },
      (tx) => tx.providerConnection.findFirst({ where: { id: connectionId, organizationId: organization.organizationId, providerType: "MICROSOFT_ENTRA", status: "ACTIVE" } }));
    if (!provider) return back(request, "signin");

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
