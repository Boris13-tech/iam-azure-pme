import {
  ProviderAdapterError,
  assertProviderOperationContext,
  type ProviderOperationContext,
  type SecretLease,
  type SecretReference,
  type SecretResolver,
} from "../..";
import { EnvironmentSecretResolver } from "../environment-secret-resolver";
import { AzureKeyVaultSecretResolver } from "./azure-key-vault";
import { CachingSecretResolver } from "./caching";
import { FederatedWorkloadTokenProvider } from "./federated-token";
import { assertSecretStoreAllowed, isProductionRuntime } from "./runtime-guard";

// F3 / G2-R02: composition root wiring for provider secrets.
// - In Production: always builds a vault-kind resolver (Azure Key Vault over REST + OIDC workload identity federation
//   + bounded memory cache), never EnvironmentSecretResolver, and enforces assertSecretStoreAllowed on construction
//   and before every secret resolution. If workload federation variables are not yet provisioned, module import and
//   secretless flows (LUXIA_LOCAL passkeys, recovery codes, existing sessions) stay unaffected, while any secret read
//   fails closed with SECRET_UNAVAILABLE (VAULT_WORKLOAD_UNCONFIGURED).
// - Outside Production: uses EnvironmentSecretResolver (still per-connection, never global).

export async function readPlatformWorkloadAssertion(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  // Trust the incoming x-vercel-oidc-token request header ONLY on the Vercel platform (VERCEL="1"),
  // where the edge proxy strips client-supplied values and injects the deployment's signed OIDC token.
  if (env.VERCEL === "1") {
    try {
      const { headers } = await import("next/headers");
      const headerToken = (await headers()).get("x-vercel-oidc-token")?.trim();
      if (headerToken) return headerToken;
    } catch {
      // Outside a Next.js request context, fall through to environment token if set by platform runtime.
    }
  }
  const envToken = (env.LUXIA_WORKLOAD_OIDC_TOKEN || env.VERCEL_OIDC_TOKEN)?.trim();
  if (envToken) return envToken;
  throw new ProviderAdapterError({
    code: "SECRET_UNAVAILABLE",
    message: "Platform OIDC workload assertion is unavailable",
    retryable: true,
    safeDetails: { reason: "WORKLOAD_ASSERTION_UNAVAILABLE" },
  });
}

class UnconfiguredVaultSecretResolver implements SecretResolver {
  readonly kind = "azure-key-vault";

  constructor(private readonly reason: "VAULT_WORKLOAD_UNCONFIGURED" | "INVALID_WORKLOAD_CONFIGURATION") {}

  async withSecret<T>(
    context: ProviderOperationContext,
    _reference: SecretReference,
    _consumer: (secret: SecretLease) => Promise<T>,
  ): Promise<T> {
    assertProviderOperationContext(context);
    throw new ProviderAdapterError({
      code: "SECRET_UNAVAILABLE",
      message: "Production secret store workload identity is not configured",
      retryable: false,
      safeDetails: {
        reason: this.reason,
        providerConnectionId: context.providerConnectionId,
      },
    });
  }
}

class GuardedSecretResolver implements SecretResolver {
  readonly kind: string;

  constructor(
    private readonly inner: SecretResolver & { kind?: string },
    private readonly envSource: () => Readonly<Record<string, string | undefined>>,
  ) {
    this.kind = inner.kind ?? "unknown";
    assertSecretStoreAllowed(this, this.envSource());
  }

  async withSecret<T>(
    context: ProviderOperationContext,
    reference: SecretReference,
    consumer: (secret: SecretLease) => Promise<T>,
  ): Promise<T> {
    assertSecretStoreAllowed(this, this.envSource());
    return this.inner.withSecret(context, reference, consumer);
  }
}

export function createRuntimeSecretResolver(options: {
  env?: Readonly<Record<string, string | undefined>>;
  assertion?: () => Promise<string>;
  fetch?: typeof fetch;
} = {}): SecretResolver & { kind: string } {
  const envSource = () => options.env ?? process.env;
  const currentEnv = envSource();

  if (!isProductionRuntime(currentEnv)) {
    return new GuardedSecretResolver(new EnvironmentSecretResolver(), envSource);
  }

  const tenantId = currentEnv.LUXIA_WORKLOAD_TENANT_ID?.trim();
  const clientId = currentEnv.LUXIA_WORKLOAD_CLIENT_ID?.trim();
  if (!tenantId || !clientId) {
    return new GuardedSecretResolver(
      new UnconfiguredVaultSecretResolver("VAULT_WORKLOAD_UNCONFIGURED"),
      envSource,
    );
  }

  let tokens: FederatedWorkloadTokenProvider;
  try {
    tokens = new FederatedWorkloadTokenProvider({
      tenantId,
      clientId,
      assertion: options.assertion ?? (() => readPlatformWorkloadAssertion(envSource())),
      fetch: options.fetch,
    });
  } catch {
    return new GuardedSecretResolver(
      new UnconfiguredVaultSecretResolver("INVALID_WORKLOAD_CONFIGURATION"),
      envSource,
    );
  }

  const vault = new CachingSecretResolver(
    new AzureKeyVaultSecretResolver({ tokens, fetch: options.fetch }),
  );
  return new GuardedSecretResolver(vault, envSource);
}
