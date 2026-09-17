import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import * as client from "openid-client";
import { getEntraOIDCConfig } from "../../../lib/auth/providers/entra";
import { AuthTransactionStore } from "../../../lib/auth/auth-transaction-store";
import { rawPrisma } from "../../../lib/db/raw-prisma";
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

    // 3. Get OIDC Config for this tenant
    const { config, redirectUri } = await getEntraOIDCConfig(provider);

    // 4. Exchange authorization code
    const tokens = await client.authorizationCodeGrant(
      config,
      url,
      {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      }
    );

    const claims = tokens.claims();
    if (!claims) {
      return NextResponse.json({ error: "No claims in token" }, { status: 400 });
    }

    // 5. Assert tid == ProviderConnection.externalScopeId
    if (claims.tid !== provider.externalScopeId) {
      console.error(`TENANT_MISMATCH: expected ${provider.externalScopeId}, got ${claims.tid}`);
      return NextResponse.json({ error: "TENANT_MISMATCH" }, { status: 403 });
    }

    // 6. Validate issuer strictly
    const expectedIssuer = `https://login.microsoftonline.com/${claims.tid}/v2.0`;
    if (claims.iss !== expectedIssuer) {
      console.error(`ISSUER_MISMATCH: expected ${expectedIssuer}, got ${claims.iss}`);
      return NextResponse.json({ error: "ISSUER_MISMATCH" }, { status: 403 });
    }

    // 7. Resolve IdentityAccount using providerConnectionId + oid
    const oid = claims.oid as string;
    if (!oid) {
      return NextResponse.json({ error: "Missing oid in token" }, { status: 400 });
    }

    const identityAccount = await rawPrisma.identityAccount.findUnique({
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
    });

    // 8. Fail closed if identity unknown
    if (!identityAccount) {
      console.warn(`IDENTITY_NOT_ONBOARDED: oid ${oid} not found in org ${transaction.expectedOrganizationId}`);
      return NextResponse.json({ error: "IDENTITY_NOT_ONBOARDED" }, { status: 403 });
    }

    const subject = identityAccount.subject;

    // 9. Create Session
    const ip = request.headers.get("x-forwarded-for") || "unknown";
    const userAgent = request.headers.get("user-agent") || "unknown";

    const session = await SessionStore.createSession({
      organizationId: transaction.expectedOrganizationId,
      tenantId: subject.tenantId,
      subjectId: subject.id,
      identityAccountId: identityAccount.id
    }, ip, userAgent);

    // 10. Set HttpOnly/Secure/SameSite=Lax luxia_session cookie
    cookies().set("luxia_session", session.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      expires: session.expiresAt,
      path: "/",
    });

    // 11. Redirect to returnTo or default
    return NextResponse.redirect(new URL(transaction.returnTo || "/dashboard", request.url));

  } catch (error) {
    console.error("Callback Error:", error);
    return NextResponse.json({ error: "Authentication failed" }, { status: 500 });
  }
}
