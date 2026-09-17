import * as client from 'openid-client';

export async function getEntraOIDCConfig() {
  const tenantId = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;
  
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Missing Entra ID configuration in environment variables");
  }

  // Ensure redirect URI points to the callback route
  const redirectUri = process.env.NEXT_PUBLIC_APP_URL 
    ? `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback` 
    : 'http://localhost:3000/auth/callback';

  // OIDC Discovery
  const issuerUrl = new URL(`https://login.microsoftonline.com/${tenantId}/v2.0`);
  const config = await client.discovery(
    issuerUrl,
    clientId,
    clientSecret
  );

  return { config, redirectUri };
}
