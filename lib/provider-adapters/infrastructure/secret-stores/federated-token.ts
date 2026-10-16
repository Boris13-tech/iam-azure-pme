import { ProviderAdapterError } from "../..";
import type { AccessTokenProvider } from "./azure-key-vault";

// F3: an Entra access token for Key Vault obtained WITHOUT a stored secret (workload identity federation). The
// assertion is a short-lived OIDC token issued by the hosting platform to this deployment; on Vercel its subject is
// owner:<team>:project:<project>:environment:<production|preview|development>, so a federated credential bound to
// environment:production cannot be used by a Preview deployment (VERIFIED in Vercel's documentation, 2026-10-14).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFRESH_MARGIN_MS = 5 * 60_000;

export class FederatedWorkloadTokenProvider implements AccessTokenProvider {
  private cached?: { token: string; expiresAt: number };
  private pending?: Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: {
    tenantId: string;
    clientId: string;
    /** The platform's OIDC token for this deployment (audience api://AzureADTokenExchange). */
    assertion: () => Promise<string>;
    scope?: string;
    /** Tests only (architecture test): production always uses https://login.microsoftonline.com. */
    authorityUrl?: string;
    fetch?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
  }) {
    if (!UUID.test(options.tenantId) || !UUID.test(options.clientId)) {
      throw new ProviderAdapterError({ code: "MISCONFIGURED", message: "Invalid workload identity configuration", safeDetails: { reason: "INVALID_IDENTIFIER" } });
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async token(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - REFRESH_MARGIN_MS) return this.cached.token;
    // One request at a time: concurrent callers share it.
    this.pending ??= this.request().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async request(): Promise<string> {
    const fail = (reason: string, retryable: boolean): never => {
      throw new ProviderAdapterError({ code: "SECRET_UNAVAILABLE", message: "Secret store access is unavailable", retryable, safeDetails: { reason } });
    };
    let assertion: string;
    try { assertion = await this.options.assertion(); } catch { return fail("WORKLOAD_ASSERTION_UNAVAILABLE", true); }
    if (typeof assertion !== "string" || assertion.split(".").length !== 3) return fail("WORKLOAD_ASSERTION_INVALID", false);
    const authority = this.options.authorityUrl ?? "https://login.microsoftonline.com";
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      scope: this.options.scope ?? "https://vault.azure.net/.default",
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(`${authority}/${this.options.tenantId}/oauth2/v2.0/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
    } catch { return fail("TOKEN_ENDPOINT_UNAVAILABLE", true); }
    if (response.status === 400 || response.status === 401 || response.status === 403) return fail("WORKLOAD_IDENTITY_DENIED", false);
    if (response.status !== 200) return fail("TOKEN_ENDPOINT_UNAVAILABLE", response.status === 429 || response.status >= 500);
    let token: unknown, expiresIn: unknown;
    try { ({ access_token: token, expires_in: expiresIn } = await response.json() as { access_token?: unknown; expires_in?: unknown }); }
    catch { return fail("TOKEN_ENDPOINT_UNEXPECTED_RESPONSE", false); }
    const seconds = Number(expiresIn);
    if (typeof token !== "string" || !token || !Number.isFinite(seconds) || seconds <= 0) return fail("TOKEN_ENDPOINT_UNEXPECTED_RESPONSE", false);
    this.cached = { token, expiresAt: this.now() + seconds * 1000 };
    return token;
  }
}
