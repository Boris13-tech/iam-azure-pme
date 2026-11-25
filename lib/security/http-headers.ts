import { FEDERATED_CSP_FORM_ACTION_ORIGINS } from "../provider-adapters/csp-origins";

// G2-R03 (F-03): Edge-compatible HTTP security headers and strict nonce-based Content-Security-Policy.
// - No Node-only ("node:*") imports so middleware.ts runs cleanly in the Edge runtime.
// - Zero 'unsafe-inline' and zero 'unsafe-eval' in Production script-src and style-src-elem.
// - Next.js 15 AppRouterAnnouncer assigns two fixed inline cssText strings for screen-reader route announcements;
//   they are pinned by exact SHA-256 hash under style-src-attr ('unsafe-hashes') rather than opening 'unsafe-inline'.
// - Referrer-Policy is set to 'same-origin': zero Referer is ever leaked cross-origin, while same-origin HTML
//   POST forms (such as /auth/logout) preserve the browser Origin header instead of serializing 'Origin: null'.

const NEXT_ROUTE_ANNOUNCER_STYLE_HASHES = [
  "'sha256-/3kWSXHts8LrwfemLzY9W0tOv5I4eLIhrf0pT8cU0WI='",
  "'sha256-2v0wUgRiMnQqfAAERz6WCRNJ9EZeUWOvHSCDVMftC6Q='",
] as const;

export const PERMISSIONS_POLICY_VALUE =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)";

export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildContentSecurityPolicy(options: {
  nonce: string;
  isDevelopment?: boolean;
  isHttps?: boolean;
}): string {
  const { nonce, isDevelopment = false, isHttps = false } = options;

  const scriptSrc = isDevelopment
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;

  const styleDirectives = isDevelopment
    ? [`style-src 'self' 'unsafe-inline'`]
    : [
        `style-src 'self' 'nonce-${nonce}'`,
        `style-src-elem 'self' 'nonce-${nonce}'`,
        `style-src-attr 'unsafe-hashes' ${NEXT_ROUTE_ANNOUNCER_STYLE_HASHES.join(" ")}`,
      ];

  const formAction = ["'self'", ...FEDERATED_CSP_FORM_ACTION_ORIGINS].join(" ");

  const directives = [
    "default-src 'self'",
    scriptSrc,
    ...styleDirectives,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    // Chromium & WebKit enforce form-action across 302/303 redirect chains (/auth/login and federated /auth/logout).
    `form-action ${formAction}`,
    ...(isHttps ? ["upgrade-insecure-requests"] : []),
  ];

  return directives.join("; ");
}

export function buildSecurityHeaders(options: {
  nonce: string;
  isDevelopment?: boolean;
  isHttps?: boolean;
}): ReadonlyArray<readonly [string, string]> {
  return [
    ["Content-Security-Policy", buildContentSecurityPolicy(options)],
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "same-origin"],
    ["Permissions-Policy", PERMISSIONS_POLICY_VALUE],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["X-DNS-Prefetch-Control", "off"],
  ];
}

export function applySecurityHeaders<T extends Response>(
  response: T,
  options: { nonce: string; isDevelopment?: boolean; isHttps?: boolean },
): T {
  for (const [key, value] of buildSecurityHeaders(options)) {
    response.headers.set(key, value);
  }
  return response;
}