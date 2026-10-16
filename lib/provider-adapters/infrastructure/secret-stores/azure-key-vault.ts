import {
  ProviderAdapterError,
  SecretLease,
  assertProviderOperationContext,
  type ProviderOperationContext,
  type SecretReference,
  type SecretResolver,
} from "../..";
import { invalidReference, parseSecretReference } from "./reference";

// F3: Azure Key Vault behind the SecretResolver port, over its REST API (no Azure SDK: fewer dependencies, and the
// core never learns which store it uses). Only references of the form akv://<vault>/<name> are served.
// Errors never carry the value, the URL or the token: only a reason and the vault/secret names.
export interface AccessTokenProvider {
  /** A bearer token for https://vault.azure.net, never logged. */
  token(): Promise<string>;
}

const API_VERSION = "7.4";

export class AzureKeyVaultSecretResolver implements SecretResolver {
  readonly kind = "azure-key-vault";
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly vaultUrl: (vault: string) => string;

  constructor(private readonly options: {
    tokens: AccessTokenProvider;
    fetch?: typeof fetch;
    timeoutMs?: number;
    /** Tests only (architecture test): production always uses https://<vault>.vault.azure.net. */
    vaultUrl?: (vault: string) => string;
  }) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.vaultUrl = options.vaultUrl ?? ((vault) => `https://${vault}.vault.azure.net`);
  }

  async withSecret<T>(context: ProviderOperationContext, reference: SecretReference, consumer: (secret: SecretLease) => Promise<T>): Promise<T> {
    assertProviderOperationContext(context);
    const parsed = parseSecretReference(reference);
    if (parsed.store !== "azure-key-vault") invalidReference();
    const where = { vault: parsed.vault, secret: parsed.name };
    const fail = (code: "SECRET_UNAVAILABLE" | "TIMEOUT", reason: string, retryable: boolean): never => {
      throw new ProviderAdapterError({ code, message: "Provider credential is unavailable", retryable, safeDetails: { reason, ...where } });
    };

    const token = await this.options.tokens.token();
    const url = `${this.vaultUrl(parsed.vault)}/secrets/${encodeURIComponent(parsed.name)}${parsed.version ? `/${parsed.version}` : ""}?api-version=${API_VERSION}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      return (error as { name?: string })?.name === "TimeoutError" ? fail("TIMEOUT", "STORE_TIMEOUT", true) : fail("SECRET_UNAVAILABLE", "STORE_UNAVAILABLE", true);
    }
    if (response.status === 401 || response.status === 403) return fail("SECRET_UNAVAILABLE", "STORE_DENIED", false);
    if (response.status === 404) return fail("SECRET_UNAVAILABLE", "NOT_FOUND", false);
    if (response.status === 429 || response.status >= 500) return fail("SECRET_UNAVAILABLE", "STORE_UNAVAILABLE", true);
    if (response.status !== 200) return fail("SECRET_UNAVAILABLE", "STORE_UNEXPECTED_RESPONSE", false);

    let value: unknown, enabled: unknown;
    try {
      const body = await response.json() as { value?: unknown; attributes?: { enabled?: unknown } };
      value = body?.value; enabled = body?.attributes?.enabled;
    } catch { return fail("SECRET_UNAVAILABLE", "STORE_UNEXPECTED_RESPONSE", false); }
    if (enabled === false) return fail("SECRET_UNAVAILABLE", "DISABLED", false);
    if (typeof value !== "string" || value.length === 0) return fail("SECRET_UNAVAILABLE", "EMPTY", false);

    const bytes = new TextEncoder().encode(value);
    const lease = new SecretLease(bytes);
    bytes.fill(0);
    try {
      return await consumer(lease);
    } finally {
      lease.dispose();
    }
  }
}
