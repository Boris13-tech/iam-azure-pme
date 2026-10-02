import * as jose from "jose";

export async function verifyMicrosoftEntraToken(token: string) {
  try {
    const tenantId =
      process.env.GRAPH_TENANT_ID || process.env.NEXT_PUBLIC_GRAPH_TENANT_ID;
    const clientId =
      process.env.GRAPH_CLIENT_ID || process.env.NEXT_PUBLIC_GRAPH_CLIENT_ID;
    if (!tenantId || !clientId) return null;
    const jwks = jose.createRemoteJWKSet(
      new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"),
    );
    const { payload } = await jose.jwtVerify(token, jwks, {
      audience: clientId,
    });
    const issuer = payload.iss || "";
    if (
      !issuer.startsWith("https://login.microsoftonline.com/") &&
      !issuer.startsWith("https://sts.windows.net/")
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
