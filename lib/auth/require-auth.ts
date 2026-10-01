import { getAuthContext, AuthContext } from "./auth-context";

/**
 * Asserts that an API request has a valid persisted session.
 * Route handlers translate this stable error into an HTTP 401 response.
 */
export async function requireAuth(): Promise<AuthContext> {
  const authContext = await getAuthContext();

  if (!authContext) {
    throw new Error("UNAUTHORIZED");
  }

  return authContext;
}
