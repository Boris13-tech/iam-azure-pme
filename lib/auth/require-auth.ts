import { getAuthContext, AuthContext } from "./auth-context";
import { redirect } from "next/navigation";
import { headers } from "next/headers";

/**
 * Asserts that the user is authenticated.
 * In a Server Component, this redirects to login if unauthenticated.
 * In an API Route Handler, this throws an error which can be caught or handled (or returns 401).
 */
export async function requireAuth(): Promise<AuthContext> {
  const authContext = await getAuthContext();

  if (!authContext) {
    // Check if it's an API route based on headers/context if possible,
    // or just let it redirect. Next.js `redirect` throws a specific error
    // that the router handles. If it's an API route, redirect might fail or send 307.
    // A better approach for strictly API routes is throwing a custom AuthError, 
    // but Next.js `redirect()` works for Page components.
    
    // Simple heuristic: if request accepts json (typical API), throw error.
    const headerStore = await headers();
    const acceptHeader = headerStore.get("accept") || "";
    if (acceptHeader.includes("application/json")) {
      throw new Error("UNAUTHORIZED");
    }

    redirect("/login");
  }

  return authContext;
}
