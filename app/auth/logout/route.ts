import { NextRequest, NextResponse } from "next/server";
import { SessionStore } from "../../../lib/auth/session-store";
import { getEntraLogoutUrl } from "../../../lib/auth/providers/entra";
import { verifyMutationOrigin } from "../../../lib/security/csrf-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // 1. Validate Origin & Fetch-Metadata against canonical app origin (fail-closed in Production).
  const originCheck = verifyMutationOrigin(req);
  if (!originCheck.ok) {
    return new Response("Forbidden", { status: 403 });
  }
  const expectedOrigin = originCheck.expectedOrigin;

  const rawToken = req.cookies.get("luxia_session")?.value;
  let session = null;

  // 2. Revoke LUXIA Session
  if (rawToken) {
    session = await SessionStore.revokeByToken(rawToken, { signOutAudit: true });
  }

  // 3. Clear cookie
  const response = NextResponse.redirect(new URL("/login", req.url), 303);
  response.cookies.set("luxia_session", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  // 4. Decide on federated logout
  const { searchParams } = new URL(req.url);
  const isFederated = searchParams.get("federated") === "true";

  if (isFederated && session) {
    const providerConnection = session.identityAccount?.providerConnection;
    if (providerConnection && providerConnection.providerType === "MICROSOFT_ENTRA") {
      try {
        const redirectUrl = await getEntraLogoutUrl({
          providerConnection,
          tenantId: session.tenantId,
          postLogoutRedirectUri: `${expectedOrigin}/login`,
        });

        if (redirectUrl) {

          // We create a new redirect response pointing to Entra, but keeping our cookie deletion
          const federatedResponse = NextResponse.redirect(new URL(redirectUrl), 303);
          federatedResponse.cookies.set("luxia_session", "", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            path: "/",
            maxAge: 0,
          });
          return federatedResponse;
        }
      } catch (e) {
        console.error("Federated logout error:", e);
        // Fallback to local logout if federated fails
      }
    }
  }

  return response;
}
