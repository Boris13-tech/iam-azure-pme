import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const sessionToken = req.cookies.get("luxia_session")?.value;

  const isRuntimeInfo = req.nextUrl.pathname === "/api/internal/runtime-info";
  // Monitoring (exact paths only): public liveness, and readiness that checks its own token.
  const isMonitoring = req.nextUrl.pathname === "/api/health" || req.nextUrl.pathname === "/api/internal/readiness";
  const isProtectedPath = req.nextUrl.pathname.startsWith("/dashboard") ||
                         (req.nextUrl.pathname.startsWith("/api/") &&
                          !req.nextUrl.pathname.startsWith("/api/auth") &&
                          !isRuntimeInfo && !isMonitoring);

  if (isProtectedPath && !sessionToken) {
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/api/:path*",
  ],
};
