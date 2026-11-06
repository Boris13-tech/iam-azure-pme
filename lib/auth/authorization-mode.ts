export type AuthorizationMode = "legacy" | "shadow" | "native-shadow-legacy" | "native";

const VALID_MODES: readonly AuthorizationMode[] = ["legacy", "shadow", "native-shadow-legacy", "native"];
// The only values that mark a process as outside Production. Anything else, unknown or blank, counts as Production.
const NON_PRODUCTION_VERCEL = ["preview", "development"];
const NON_PRODUCTION_APP = ["development", "test", "staging", "preview"];

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
  if (env.VERCEL_ENV === "production" || env.APP_ENV === "production") return null;
  if (env.NODE_ENV === "production" && !NON_PRODUCTION_VERCEL.includes(env.VERCEL_ENV ?? "") && !NON_PRODUCTION_APP.includes(env.APP_ENV ?? "")) return null;
  if (rawMode) console.warn("[AUTHZ] Unknown AUTHZ_MODE outside Production, falling back to 'legacy'");
  return "legacy";
}
