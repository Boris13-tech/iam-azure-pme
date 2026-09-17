import { cookies } from "next/headers";
import { SessionStore } from "./session-store";

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
  const sessionCookie = cookies().get("luxia_session");
  
  if (!sessionCookie || !sessionCookie.value) {
    return null;
  }

  const session = await SessionStore.getSession(sessionCookie.value);

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
