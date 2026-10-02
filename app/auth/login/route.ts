import { NextResponse } from "next/server";
import { beginEntraAuthentication } from "../../../lib/auth/providers/entra";
import { AuthTransactionStore } from "../../../lib/auth/auth-transaction-store";
import { rawPrisma } from "../../../lib/db/raw-prisma";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const returnTo = searchParams.get("returnTo") || "/dashboard";
    const tenantId = searchParams.get("tenant");
    const connectionId = searchParams.get("connection");

    if (!tenantId || !connectionId) {
      return NextResponse.json({ error: "Missing tenant or connection parameter" }, { status: 400 });
    }

    // 1. Lookup Tenant and ProviderConnection
    const tenant = await rawPrisma.tenant.findUnique({
      where: { id: tenantId }
    });
    
    if (!tenant) {
      return NextResponse.json({ error: "Invalid tenant" }, { status: 400 });
    }

    const provider = await rawPrisma.providerConnection.findUnique({
      where: { id: connectionId }
    });

    if (!provider || provider.organizationId !== tenant.organizationId) {
      return NextResponse.json({ error: "Invalid connection for this tenant" }, { status: 400 });
    }

    if (provider.providerType !== "MICROSOFT_ENTRA") {
      return NextResponse.json({ error: "Unsupported provider type" }, { status: 400 });
    }

    // 2. Build the provider request behind the adapter boundary.
    const challenge = await beginEntraAuthentication({
      providerConnection: provider,
      tenantId: tenant.id,
      returnTo,
    });
    const state = challenge.transactionId;
    const nonce = challenge.continuation?.nonce;
    const codeVerifier = challenge.continuation?.codeVerifier;
    if (!challenge.redirectUrl || !nonce || !codeVerifier) {
      throw new Error("Invalid Microsoft Entra authentication challenge");
    }

    // 4. Persist the auth transaction securely
    await AuthTransactionStore.createTransaction({
      stateHash: state,
      nonce,
      codeVerifier,
      expectedOrganizationId: provider.organizationId,
      expectedTenantId: tenant.id,
      expectedProviderConnectionId: provider.id,
      returnTo,
      expiresInMinutes: 10
    });

    // 5. Redirect to the URL validated and produced by the adapter.
    return NextResponse.redirect(challenge.redirectUrl);

  } catch (error) {
    console.error("Login Error:", error);
    return NextResponse.json({ error: "Failed to initiate login" }, { status: 500 });
  }
}
