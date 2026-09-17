import { NextResponse } from "next/server";
import * as client from "openid-client";
import { getEntraOIDCConfig } from "../../../lib/auth/providers/entra";
import { AuthTransactionStore } from "../../../lib/auth/auth-transaction-store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const returnTo = searchParams.get("returnTo") || "/dashboard";

    // 1. Get Entra Configuration
    const { config, redirectUri } = await getEntraOIDCConfig();

    // 2. Generate PKCE values, state, and nonce
    const code_verifier = client.randomPKCECodeVerifier();
    const code_challenge = await client.calculatePKCECodeChallenge(code_verifier);
    
    const state = client.randomState();
    const nonce = client.randomNonce();

    // 3. Persist the auth transaction securely
    await AuthTransactionStore.createTransaction({
      stateHash: state, // in a real world scenario, hashing this is better, but state is unguessable anyway
      nonce,
      codeVerifier: code_verifier,
      returnTo,
      expiresInMinutes: 10
    });

    // 4. Build the Authorization Request URL
    const authorizationUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: "openid profile email", // Explicitly avoiding User.Read for now
      code_challenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });

    // 5. Redirect the user to Microsoft Entra
    return NextResponse.redirect(authorizationUrl.href);

  } catch (error) {
    console.error("Login Error:", error);
    return NextResponse.json({ error: "Failed to initiate login" }, { status: 500 });
  }
}
