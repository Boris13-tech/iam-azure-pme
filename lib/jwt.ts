import * as jose from "jose";

/**
 * Server-side token validation (Edge-compatible with jose)
 * Compatible avec Microsoft Entra ID (anciennement Azure AD)
 */
export const verifyToken = async (token: string) => {
  try {
    const tenantId = process.env.GRAPH_TENANT_ID;
    const clientId = process.env.GRAPH_CLIENT_ID;

    if (!tenantId || !clientId) {
      console.error("Missing GRAPH_TENANT_ID or GRAPH_CLIENT_ID env variables");
      return null;
    }

    const JWKS = jose.createRemoteJWKSet(
      new URL(
        `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`
      )
    );

    const { payload } = await jose.jwtVerify(token, JWKS, {
      audience: clientId,
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    });

    return payload;
  } catch (error) {
    console.error("Token validation failed", error);
    return null;
  }
};
