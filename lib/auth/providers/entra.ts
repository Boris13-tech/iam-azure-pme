import * as client from 'openid-client';
import { ProviderConnection } from '@prisma/client';

export async function getEntraOIDCConfig(providerConnection: ProviderConnection) {
  const clientId = process.env.ENTRA_AUTH_CLIENT_ID;
  const clientSecret = process.env.ENTRA_AUTH_CLIENT_SECRET;
  
  if (!clientId || !clientSecret) {
    throw new Error("Missing ENTRA_AUTH_CLIENT configuration in environment variables");
  }

  // Ensure redirect URI points to the callback route
  const redirectUri = process.env.NEXT_PUBLIC_APP_URL 
    ? `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback` 
    : 'http://localhost:3000/auth/callback';

  // OIDC Discovery on tenant-specific endpoint
  // ProviderConnection.externalScopeId holds the Entra tenant ID (tid)
  const issuerUrl = new URL(`https://login.microsoftonline.com/${providerConnection.externalScopeId}/v2.0`);
  const config = await client.discovery(
    issuerUrl,
    clientId,
    clientSecret
  );

  return { config, redirectUri };
}
