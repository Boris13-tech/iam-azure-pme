import { cookies } from "next/headers";
import { SessionStore } from "./session-store";
import { resolveAuthorizationMode } from "./authorization-mode";
import { reportError } from "../monitoring/error-reporter";

export type AuthContext = {
  sessionId: string;
  organizationId: string;
  tenantId: string;
  subjectId: string;
  identityAccountId: string;
};

/**
 * Retrieves the current AuthContext from the luxia_session cookie.
 * Returns null if not authenticated or session is invalid.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  // Every authorizing path starts from this session, including those that do not go through the gateway
  // (resources, SoD, access reviews, onboarding, dashboard). With no valid mode in Production none is honoured (I3).
  if (resolveAuthorizationMode() === null) {
    console.error("[AUTHZ] AUTHZ_MODE_INVALID: missing or unknown in Production, no session honoured");
    return null;
  }
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("luxia_session");
  
  if (!sessionCookie || !sessionCookie.value) {
    return null;
  }

  let session;
  try {
    session = await SessionStore.getSession(sessionCookie.value);
  } catch (error) {
    // SLI-03 (session resolution availability): a failure to resolve a session is reported as such, then the
    // request fails exactly as before.
    await reportError(error, "session");
    throw error;
  }

  if (!session) {
    return null;
  }

  return {
    sessionId: session.id, // Store the hashed ID internally
    organizationId: session.organizationId,
    tenantId: session.tenantId,
    subjectId: session.subjectId,
    identityAccountId: session.identityAccountId,
  };
}
