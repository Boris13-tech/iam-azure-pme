import { NextRequest, NextResponse } from "next/server";
import {
  applySecurityHeaders,
  buildContentSecurityPolicy,
  generateCspNonce,
} from "./lib/security/http-headers";

export function middleware(req: NextRequest) {
  const nonce = generateCspNonce();
  const isDevelopment = process.env.NODE_ENV === "development";
  const isHttps =
    req.nextUrl.protocol === "https:" ||
    req.headers.get("x-forwarded-proto") === "https" ||
    process.env.VERCEL_ENV === "production";
  const headerOptions = { nonce, isDevelopment, isHttps };

  const sessionToken = req.cookies.get("luxia_session")?.value;

  const isRuntimeInfo = req.nextUrl.pathname === "/api/internal/runtime-info";
  // R3 daily retention job (exact path): the route checks the platform cron secret itself.
  const isRetentionJob = req.nextUrl.pathname === "/api/internal/retention";
  // Monitoring (exact paths only): public liveness, and readiness that checks its own token.
  const isMonitoring = req.nextUrl.pathname === "/api/health" || req.nextUrl.pathname === "/api/internal/readiness";
  const isProtectedPath = req.nextUrl.pathname.startsWith("/dashboard") ||
                         (req.nextUrl.pathname.startsWith("/api/") &&
                          !req.nextUrl.pathname.startsWith("/api/auth") &&
                          !isRuntimeInfo && !isMonitoring && !isRetentionJob);

  if (isProtectedPath && !sessionToken) {
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return applySecurityHeaders(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        headerOptions,
      );
    }
    return applySecurityHeaders(
      NextResponse.redirect(new URL("/login", req.url)),
      headerOptions,
    );
  }

  // Forward x-nonce and Content-Security-Policy on the request so Next.js 15 App Router automatically
  // attaches nonce="<nonce>" to its inline bootstrap and RSC flight <script> tags.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", buildContentSecurityPolicy(headerOptions));

  return applySecurityHeaders(
    NextResponse.next({ request: { headers: requestHeaders } }),
    headerOptions,
  );
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|icon\\.svg).*)",
  ],
};
