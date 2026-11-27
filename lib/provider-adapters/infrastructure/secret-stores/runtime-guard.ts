// F3 invariant: Production never reads provider secrets from the process environment. The environment store is a
// development and test convenience; in Production every secret comes from a vault, per connection, by reference.
// Aligned with lib/auth/authorization-mode.ts (isProductionProcess): an unmarked NODE_ENV=production process
// also counts as Production (fail closed).
const NON_PRODUCTION_VERCEL = ["preview", "development"];
const NON_PRODUCTION_APP = ["development", "test", "staging", "preview"];

export function isProductionRuntime(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (env.VERCEL_ENV === "production" || env.APP_ENV === "production") return true;
  return (
    env.NODE_ENV === "production" &&
    !NON_PRODUCTION_VERCEL.includes(env.VERCEL_ENV ?? "") &&
    !NON_PRODUCTION_APP.includes(env.APP_ENV ?? "")
  );
}

export function assertSecretStoreAllowed(
  resolver: { kind?: string },
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (
    isProductionRuntime(env) &&
    (resolver.kind === undefined || resolver.kind === "environment" || resolver.kind === "unknown")
  ) {
    throw new Error("PRODUCTION_SECRET_STORE_REQUIRED");
  }
}
