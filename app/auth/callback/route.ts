import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { completeEntraAuthentication } from "../../../lib/auth/providers/entra";
import { ProviderAdapterError } from "../../../lib/provider-adapters";
import { AuthTransactionStore } from "../../../lib/auth/auth-transaction-store";
import { rawPrisma } from "../../../lib/db/raw-prisma";
import { withTenantDb } from "../../../lib/db/scoped-client";
import { SessionStore } from "../../../lib/auth/session-store";

export const runtime = "nodejs";

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

    // 2. Fetch ProviderConnection
    const provider = await rawPrisma.providerConnection.findUnique({
      where: { id: transaction.expectedProviderConnectionId }
    });

    if (!provider || provider.organizationId !== transaction.expectedOrganizationId) {
      return NextResponse.json({ error: "Provider mismatch" }, { status: 400 });
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

    const { session, rawToken } = await SessionStore.createSession({
      organizationId: transaction.expectedOrganizationId,
      tenantId: transaction.expectedTenantId,
      subjectId: subject.id,
      identityAccountId: identityAccount.id
    }, ip, userAgent);

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
