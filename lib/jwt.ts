import * as jose from "jose";

/**
 * Server-side token validation (Edge-compatible with jose)
 * Compatible avec Microsoft Entra ID (anciennement Azure AD)
 */
export const verifyToken = async (token: string) => {
  try {
    const tenantId = process.env.GRAPH_TENANT_ID || process.env.NEXT_PUBLIC_GRAPH_TENANT_ID;
    const clientId = process.env.GRAPH_CLIENT_ID || process.env.NEXT_PUBLIC_GRAPH_CLIENT_ID;

    if (!tenantId || !clientId) {
      console.error("Missing GRAPH_TENANT_ID or GRAPH_CLIENT_ID env variables (and public fallbacks)");
      return null;
    }

    // Use common discovery keys to ensure we support all Microsoft Entra ID signing keys
    // (works for single-tenant, multi-tenant, v1 and v2 keys)
    const JWKS = jose.createRemoteJWKSet(
      new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys")
    );

    // Verify token signature and audience (matching our Client ID)
    const { payload } = await jose.jwtVerify(token, JWKS, {
      audience: clientId,
    });

    // Manually verify that the issuer belongs to Microsoft Entra ID
    const issuer = payload.iss || "";
    const isValidIssuer = 
      issuer.startsWith("https://login.microsoftonline.com/") || 
      issuer.startsWith("https://sts.windows.net/");
      
    if (!isValidIssuer) {
      console.error("Invalid token issuer:", issuer);
      return null;
    }

    return payload;
  } catch (error) {
    console.error("Token validation failed in verifyToken:", error);
    return null;
  }
};
