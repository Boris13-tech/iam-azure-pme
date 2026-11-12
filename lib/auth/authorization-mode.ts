export type AuthorizationMode = "legacy" | "shadow" | "native-shadow-legacy" | "native";

const VALID_MODES: readonly AuthorizationMode[] = ["legacy", "shadow", "native-shadow-legacy", "native"];
// The only values that mark a process as outside Production. Anything else, unknown or blank, counts as Production.
const NON_PRODUCTION_VERCEL = ["preview", "development"];
const NON_PRODUCTION_APP = ["development", "test", "staging", "preview"];

/**
 * Whether this process runs as Production: Vercel or LUXIA marks it, or it is a production build that no platform marks
 * with a known non-Production value. The single definition shared by the authorization mode and readiness.
 */
export function isProductionProcess(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (env.VERCEL_ENV === "production" || env.APP_ENV === "production") return true;
  return env.NODE_ENV === "production" && !NON_PRODUCTION_VERCEL.includes(env.VERCEL_ENV ?? "") && !NON_PRODUCTION_APP.includes(env.APP_ENV ?? "");
}

/**
 * The authorization mode from the environment. In Production (Vercel or LUXIA marks it, or a production process that
 * no platform marks with a known non-Production value), a missing or unknown AUTHZ_MODE resolves to null, and then no
 * session is honoured (auth-context.ts) and the gateway refuses (fail closed, I3), never a silent fallback to legacy.
 * Elsewhere (development, CI, previews) the legacy fallback is kept. The configured value is never logged.
 */
export function resolveAuthorizationMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AuthorizationMode | null {
  const rawMode = env.AUTHZ_MODE;
  if (VALID_MODES.includes(rawMode as AuthorizationMode)) return rawMode as AuthorizationMode;
  if (isProductionProcess(env)) return null;
  if (rawMode) console.warn("[AUTHZ] Unknown AUTHZ_MODE outside Production, falling back to 'legacy'");
  return "legacy";
}

/** The error of a path refused because the mode is missing or unknown in Production. */
export class AuthorizationModeInvalidError extends Error {
  readonly code = "AUTHZ_MODE_INVALID";
  constructor() { super("AUTHZ_MODE_INVALID"); }
}

/**
 * Fail closed outside the session too. Every path that decides or grants authority without a full session
 * (requireNative, the administrator grant behind signup and invitation acceptance, the recovery session) calls this
 * first: with no valid mode in Production nothing is decided, granted or honoured. Sign-out stays possible.
 */
export function authorizationModeValid(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (resolveAuthorizationMode(env) !== null) return true;
  console.error("[AUTHZ] AUTHZ_MODE_INVALID: missing or unknown in Production, refused");
  return false;
}
