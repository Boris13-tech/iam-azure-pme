import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { completeEntraAuthentication } from "../../../lib/auth/providers/entra";
import { ProviderAdapterError } from "../../../lib/provider-adapters";
import { AuthTransactionStore } from "../../../lib/auth/auth-transaction-store";
import { withTenantDb } from "../../../lib/db/scoped-client";
import { SessionCreationDeniedError, SessionStore } from "../../../lib/auth/session-store";
import { entraSignInEvidence, recordRejectedSignIn } from "../../../lib/auth/sign-in-evidence";
import { completeGenericOidcSignIn } from "../../../lib/auth/generic-oidc-sign-in";
import { PROOF_RETURN_PATH, completeConnectionProof } from "../../../lib/admin/provider-connection-proof";

export const runtime = "nodejs";

// The browser supplies `state` (to find the transaction) and the provider's answer, nothing else that is trusted: the
// connection, organization, tenant, purpose and (generic OIDC) configuration all come from the single-use AuthTransaction
// found by `state`, consumed atomically before anything else.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");

    if (!state) {
      return NextResponse.json({ error: "Missing state parameter" }, { status: 400 });
    }

    // 1. Consume AuthTransaction
    const transaction = await AuthTransactionStore.consumeTransaction(state);
    if (!transaction) {
      return NextResponse.json({ error: "Invalid or expired transaction" }, { status: 400 });
    }
    // F4 (S5): an activation proof completes in the browser of the administrator who started it. It never opens a
    // session and never sets a cookie: its only answer is a fixed page with "passed" or "failed".
    if (transaction.purpose === "ACTIVATION_PROOF") {
      const proof = await completeConnectionProof({ transaction, state, currentUrl: url.href });
      return NextResponse.redirect(new URL(`${PROOF_RETURN_PATH}?providerProof=${proof}`, request.url), 303);
    }
    // F4 (S4): any other purpose than SIGN_IN (linking, until slice S6) is consumed and refused with the generic answer,
    // before any call to the provider.
    if (transaction.purpose !== "SIGN_IN") return NextResponse.redirect(new URL("/login?error=signin", request.url), 303);

    // 2. Fetch ProviderConnection, inside the organization's scope
    const provider = await withTenantDb(
      { organizationId: transaction.expectedOrganizationId, tenantId: transaction.expectedTenantId },
      (tx) => tx.providerConnection.findFirst({
        where: { id: transaction.expectedProviderConnectionId, organizationId: transaction.expectedOrganizationId },
      }),
    );

    if (!provider || provider.organizationId !== transaction.expectedOrganizationId) {
      return NextResponse.json({ error: "Provider mismatch" }, { status: 400 });
    }
    // F2 kill switch: a connection disabled or quarantined since the sign-in started gets the generic answer,
    // before any call to the provider.
    if (provider.status !== "ACTIVE") return NextResponse.redirect(new URL("/login?error=signin", request.url), 303);

    // F4 (S4): a generic OIDC connection completes through the same core, with generic answers only.
    if (provider.providerType === "OIDC_GENERIC") {
      const outcome = await completeGenericOidcSignIn({
        transaction, provider, state, currentUrl: url.href,
        ip: request.headers.get("x-forwarded-for") || "unknown",
        userAgent: request.headers.get("user-agent") || "unknown",
      });
      if (outcome.kind === "REFUSED") return NextResponse.redirect(new URL(`/login?error=${outcome.answer}`, request.url), 303);
      const genericCookies = await cookies();
      genericCookies.set("luxia_session", outcome.rawToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        expires: outcome.expiresAt,
        path: "/",
      });
      return NextResponse.redirect(new URL(transaction.returnTo || "/dashboard", request.url));
    }

    // 3. Exchange and validate the authorization response inside the adapter.
    let verifiedIdentity;
    try {
      verifiedIdentity = await completeEntraAuthentication({
        providerConnection: provider,
        tenantId: transaction.expectedTenantId,
        state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
        currentUrl: url.href,
      });
    } catch (error) {
      if (error instanceof ProviderAdapterError) {
        const reason = error.safeDetails.reason;
        if (reason === "TENANT_MISMATCH" || reason === "ISSUER_MISMATCH") {
          return NextResponse.json({ error: reason }, { status: 403 });
        }
        if (reason === "NO_CLAIMS") {
          return NextResponse.json({ error: "No claims in token" }, { status: 400 });
        }
        if (reason === "MISSING_OID") {
          return NextResponse.json({ error: "Missing oid in token" }, { status: 400 });
        }
      }
      throw error;
    }

    // 4. Resolve IdentityAccount using providerConnectionId + external oid.
    const oid = verifiedIdentity.identity.externalObjectId;

    const identityAccount = await withTenantDb(
      { organizationId: transaction.expectedOrganizationId, tenantId: transaction.expectedTenantId },
      async (tx) => tx.identityAccount.findUnique({
        where: {
          organizationId_providerConnectionId_externalObjectId: {
            organizationId: transaction.expectedOrganizationId,
            providerConnectionId: provider.id,
            externalObjectId: oid,
          }
        },
        include: {
          subject: true
        }
      })
    );

    // 5. Fail closed if identity unknown
    if (!identityAccount) {
      console.warn(`IDENTITY_NOT_ONBOARDED: oid ${oid} not found in org ${transaction.expectedOrganizationId}`);
      return NextResponse.json({ error: "IDENTITY_NOT_ONBOARDED" }, { status: 403 });
    }

    // Assert Tenant Boundary
    if (identityAccount.tenantId !== transaction.expectedTenantId) {
      console.error(`TENANT_BOUNDARY_VIOLATION: expected ${transaction.expectedTenantId}, got ${identityAccount.tenantId}`);
      return NextResponse.json({ error: "TENANT_BOUNDARY_VIOLATION" }, { status: 403 });
    }

    const subject = identityAccount.subject;

    // 6. Create Session
    const ip = request.headers.get("x-forwarded-for") || "unknown";
    const userAgent = request.headers.get("user-agent") || "unknown";

    // Security Journal v1: the identity is resolved here, so the outcome is attributable.
    const signInIdentity = {
      organizationId: transaction.expectedOrganizationId,
      tenantId: transaction.expectedTenantId,
      subjectId: subject.id,
      identityAccountId: identityAccount.id,
      providerConnectionId: provider.id,
    };
    let createdSession;
    try {
      // W1: VERIFIED evidence is written in the session transaction; no evidence means no session.
      createdSession = await SessionStore.createSession({
        organizationId: transaction.expectedOrganizationId,
        tenantId: transaction.expectedTenantId,
        subjectId: subject.id,
        identityAccountId: identityAccount.id
      }, ip, userAgent, { evidence: entraSignInEvidence(signInIdentity, "VERIFIED", "ENTRA_OIDC_VERIFIED") });
    } catch (error) {
      if (error instanceof SessionCreationDeniedError) {
        // W2: refusal for a known identity is recorded; the refusal stands whatever happens.
        await recordRejectedSignIn(entraSignInEvidence(signInIdentity, "REJECTED", error.reason));
        // B3: the organization status is never revealed; same generic return as an unknown organization.
        if (error.reason === "ORGANIZATION_NOT_ACTIVE") return NextResponse.redirect(new URL("/login?error=signin", request.url), 303);
        // F2: a connection disabled or quarantined meanwhile gets the same generic answer.
        if (error.reason === "PROVIDER_CONNECTION_NOT_ACTIVE") return NextResponse.redirect(new URL("/login?error=signin", request.url), 303);
        return NextResponse.json({ error: error.reason }, { status: 403 });
      }
      throw error;
    }
    const { session, rawToken } = createdSession;

    // 7. Set HttpOnly/Secure/SameSite=Lax luxia_session cookie
    const cookieStore = await cookies();
    cookieStore.set("luxia_session", rawToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      expires: session.expiresAt,
      path: "/",
    });

    // 8. Redirect to returnTo or default
    return NextResponse.redirect(new URL(transaction.returnTo || "/dashboard", request.url));

  } catch (error) {
    console.error("Callback Error:", error);
    return NextResponse.json({ error: "Authentication failed" }, { status: 500 });
  }
}
