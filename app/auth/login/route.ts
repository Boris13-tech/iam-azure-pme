import { NextResponse } from "next/server";
import { beginEntraAuthentication } from "../../../lib/auth/providers/entra";
import { beginGenericOidcAuthentication } from "../../../lib/auth/providers/oidc-generic";
import { AuthTransactionStore } from "../../../lib/auth/auth-transaction-store";
import { withTenantDb } from "../../../lib/db/scoped-client";
import { normalizeOrganizationSlug, resolveLoginOrganization, safeReturnTo, singleFederationConnection } from "../../../lib/auth/organization-login";
import { allowRequest, clientNetworkKey } from "../../../lib/security/rate-limit";

export const runtime = "nodejs";

// Federated sign-in for one organization, resolved on the server from its identifier (slug). Without `provider` (or
// with provider=microsoft) this is the Microsoft sign-in, unchanged; provider=oidc is the organization's generic OIDC
// connection (F4, S4). Unknown organization, organization without exactly one connection of that type, unknown
// provider, or a rate-limited client: the same generic return to the login page. A known organization with such a
// connection redirects to its provider (home-realm discovery, accepted residual risk); no organization data is shown.
const back = (request: Request, error: string) => NextResponse.redirect(new URL(`/login?error=${error}`, request.url), 303);

export async function GET(request: Request) {
  let generic = false;
  try {
    // One budget for every federated sign-in start, whatever the provider.
    if (!await allowRequest("login-entra", clientNetworkKey(request))) return back(request, "rate_limited");
    const { searchParams } = new URL(request.url);
    const requested = searchParams.get("provider") ?? "microsoft";
    const providerType = requested === "microsoft" ? "MICROSOFT_ENTRA" : requested === "oidc" ? "OIDC_GENERIC" : null;
    if (!providerType) return back(request, "signin");
    generic = providerType === "OIDC_GENERIC";
    const slug = normalizeOrganizationSlug(searchParams.get("org"));
    const returnTo = safeReturnTo(searchParams.get("returnTo"));
    const organization = slug ? await resolveLoginOrganization(slug) : null;
    const connectionId = organization ? singleFederationConnection(organization, providerType) : null;
    if (!organization || !connectionId) return back(request, "signin");

    // Read inside the organization's scope; only an ACTIVE connection starts a sign-in (F2 kill switch).
    const provider = await withTenantDb({ organizationId: organization.organizationId, tenantId: organization.tenantId },
      (tx) => tx.providerConnection.findFirst({ where: { id: connectionId, organizationId: organization.organizationId, providerType, status: "ACTIVE" } }));
    if (!provider) return back(request, "signin");

    // Build the provider request behind the adapter boundary.
    const challenge = generic
      ? await beginGenericOidcAuthentication({ providerConnection: provider, tenantId: organization.tenantId, returnTo })
      : await beginEntraAuthentication({
        providerConnection: provider,
        tenantId: organization.tenantId,
        returnTo,
      });
    const state = challenge.transactionId;
    const nonce = challenge.continuation?.nonce;
    const codeVerifier = challenge.continuation?.codeVerifier;
    // F4: a generic round trip is bound to the configuration it starts with (the callback refuses any other).
    const configurationHash = generic ? challenge.continuation?.configurationHash : undefined;
    if (!challenge.redirectUrl || !nonce || !codeVerifier || (generic && !configurationHash)) {
      throw new Error("Invalid federated authentication challenge");
    }

    // Persist the auth transaction securely: the callback takes the connection, scope and configuration from it only.
    await AuthTransactionStore.createTransaction({
      stateHash: state,
      nonce,
      codeVerifier,
      expectedOrganizationId: provider.organizationId,
      expectedTenantId: organization.tenantId,
      expectedProviderConnectionId: provider.id,
      ...(generic ? { purpose: "SIGN_IN" as const, expectedConfigurationHash: configurationHash } : {}),
      returnTo,
      expiresInMinutes: 10
    });

    // Redirect to the URL validated and produced by the adapter.
    return NextResponse.redirect(challenge.redirectUrl);
  } catch {
    console.error(generic ? "OIDC_LOGIN_BEGIN_FAILED" : "ENTRA_LOGIN_BEGIN_FAILED");
    return back(request, "unavailable");
  }
}
