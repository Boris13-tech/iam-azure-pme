import * as jose from "jose";

/**
 * Server-side token validation (Edge-compatible with jose)
 */
export const verifyToken = async (token: string) => {
  try {
    const JWKS = jose.createRemoteJWKSet(
      new URL(
        `https://${process.env.NEXT_PUBLIC_AZURE_AD_B2C_TENANT_NAME}.b2clogin.com/${process.env.NEXT_PUBLIC_AZURE_AD_B2C_TENANT_NAME}.onmicrosoft.com/${process.env.NEXT_PUBLIC_AZURE_AD_B2C_PRIMARY_USER_FLOW}/discovery/v2.0/keys`
      )
    );

    const { payload } = await jose.jwtVerify(token, JWKS, {
      audience: process.env.NEXT_PUBLIC_AZURE_AD_B2C_CLIENT_ID,
      issuer: `https://${process.env.NEXT_PUBLIC_AZURE_AD_B2C_TENANT_NAME}.b2clogin.com/${process.env.GRAPH_TENANT_ID}/v2.0/`, // Replace GRAPH_TENANT_ID with the exact issuer tenant ID if different
    });

    return payload;
  } catch (error) {
    console.error("Token validation failed", error);
    return null;
  }
};