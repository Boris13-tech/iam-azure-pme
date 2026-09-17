import { NextResponse } from "next/server";
import * as client from "openid-client";
import { getEntraOIDCConfig } from "../../../lib/auth/providers/entra";
import { AuthTransactionStore } from "../../../lib/auth/auth-transaction-store";
import { rawPrisma } from "../../../lib/db/raw-prisma";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const returnTo = searchParams.get("returnTo") || "/dashboard";
    const connectionId = searchParams.get("connection");

    if (!connectionId) {
      return NextResponse.json({ error: "Missing connection parameter" }, { status: 400 });
    }

    // 1. Lookup ProviderConnection
    const provider = await rawPrisma.providerConnection.findUnique({
      where: { id: connectionId }
    });

    if (!provider) {
      return NextResponse.json({ error: "Invalid connection" }, { status: 400 });
    }

    if (provider.providerType !== "MICROSOFT_ENTRA") {
      return NextResponse.json({ error: "Unsupported provider type" }, { status: 400 });
    }

    // 2. Get Entra Configuration specific to this tenant
    const { config, redirectUri } = await getEntraOIDCConfig(provider);

    // 3. Generate PKCE values, state, and nonce
    const code_verifier = client.randomPKCECodeVerifier();
    const code_challenge = await client.calculatePKCECodeChallenge(code_verifier);
    
    const state = client.randomState();
    const nonce = client.randomNonce();

    // 4. Persist the auth transaction securely
    await AuthTransactionStore.createTransaction({
      stateHash: state,
      nonce,
      codeVerifier: code_verifier,
      expectedOrganizationId: provider.organizationId,
      expectedProviderConnectionId: provider.id,
      returnTo,
      expiresInMinutes: 10
    });

    // 5. Build the Authorization Request URL
    const authorizationUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: "openid profile email", // Explicitly avoiding User.Read for now
      code_challenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });

    // 6. Redirect the user to Microsoft Entra
    return NextResponse.redirect(authorizationUrl.href);

  } catch (error) {
    console.error("Login Error:", error);
    return NextResponse.json({ error: "Failed to initiate login" }, { status: 500 });
  }
}
