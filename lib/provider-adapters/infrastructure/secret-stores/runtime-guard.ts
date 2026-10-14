// F3 invariant: Production never reads provider secrets from the process environment. The environment store is a
// development and test convenience; in Production every secret comes from a vault, per connection, by reference.
// Wired at the composition root once the vault holds the secrets (F3 rollout); tested now.
export function isProductionRuntime(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.VERCEL_ENV === "production" || env.APP_ENV === "production";
}

export function assertSecretStoreAllowed(resolver: { kind?: string }, env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (isProductionRuntime(env) && (resolver.kind === undefined || resolver.kind === "environment" || resolver.kind === "unknown")) {
    throw new Error("PRODUCTION_SECRET_STORE_REQUIRED");
  }
}
