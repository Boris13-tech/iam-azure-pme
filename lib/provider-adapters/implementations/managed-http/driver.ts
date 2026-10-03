import { z } from "zod";
import { oidcMetadataRequest } from "./oidc-http";
import { EnvironmentSecretResolver } from "../../infrastructure/environment-secret-resolver";
import type { ProviderOperationContext } from "../..";
import { normalizeCloudIdentity } from "../cloud-providers/normalization";
import { connectionSecretReference, applyAttributeMapping, attributeMappingSchema, configurationSchema, ProviderManagementFailure,
  type ProviderManagementDriver } from "../../../provider-management/contracts";

const MAX_RESPONSE_BYTES = 1_000_000;
async function request(url: string, options: RequestInit = {}): Promise<unknown> {
  // URLs are fixed provider origins or deployment-approved OIDC issuers. No redirects.
  try {
    const response = await fetch(url, { ...options, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new ProviderManagementFailure(
      response.status === 401 || response.status === 403 ? "PROVIDER_ACCESS_DENIED" : "PROVIDER_HTTP_FAILURE");
    if (!response.body) throw new ProviderManagementFailure("INVALID_PROVIDER_RESPONSE");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.length;
        if (length > MAX_RESPONSE_BYTES) throw new ProviderManagementFailure("PROVIDER_RESPONSE_TOO_LARGE");
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    const data = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(data));
  } catch (error) {
    if (error instanceof ProviderManagementFailure) throw error;
    throw new ProviderManagementFailure("PROVIDER_UNAVAILABLE");
  }
}

export function createManagedHttpDriver(input: {
  context: ProviderOperationContext; type: string; externalScopeId: string;
  configuration: unknown; attributeMapping: unknown; credentialSecretRef: string | null;
}): ProviderManagementDriver {
  const config = configurationSchema.parse(input.configuration);
  const mapping = attributeMappingSchema.parse(input.attributeMapping);
  const secrets = new EnvironmentSecretResolver();
  let bearer: string | undefined;
  const token = async () => {
    if (bearer) return bearer;
    if (input.credentialSecretRef !== connectionSecretReference(input.context)) {
      throw new ProviderManagementFailure("PROVIDER_SECRET_UNAVAILABLE");
    }
    try {
      bearer = await secrets.withSecret(input.context, { key: input.credentialSecretRef }, lease => lease.use(async bytes => {
        const secret = new TextDecoder().decode(bytes);
        if (input.type === "GOOGLE_WORKSPACE") return secret;
        if (input.type !== "MICROSOFT_ENTRA" || !config.clientId || !z.string().uuid().safeParse(input.externalScopeId).success) {
          throw new ProviderManagementFailure("PROVIDER_CONFIGURATION_INCOMPLETE");
        }
        const payload = await request(`https://login.microsoftonline.com/${input.externalScopeId}/oauth2/v2.0/token`, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: config.clientId, client_secret: secret,
            grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }),
        });
        return z.object({ access_token: z.string().min(1) }).parse(payload).access_token;
      }));
      return bearer;
    } catch (error) {
      if (error instanceof ProviderManagementFailure) throw error;
      throw new ProviderManagementFailure("PROVIDER_SECRET_UNAVAILABLE");
    }
  };

  const page = async (cursor?: string) => {
    let url: URL;
    if (input.type === "MICROSOFT_ENTRA") {
      url = new URL(cursor ?? "https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName&$top=100");
      if (url.origin !== "https://graph.microsoft.com" || url.pathname !== "/v1.0/users" || url.username || url.password) {
        throw new ProviderManagementFailure("UNSAFE_PROVIDER_CURSOR");
      }
    } else if (input.type === "GOOGLE_WORKSPACE") {
      if (!config.customerId || config.customerId !== input.externalScopeId || config.customerId === "my_customer") {
        throw new ProviderManagementFailure("PROVIDER_CUSTOMER_SCOPE_REQUIRED");
      }
      url = new URL("https://admin.googleapis.com/admin/directory/v1/users");
      url.searchParams.set("customer", config.customerId); url.searchParams.set("maxResults", "100");
      url.searchParams.set("projection", "basic");
      if (cursor) url.searchParams.set("pageToken", cursor);
    } else throw new ProviderManagementFailure("DIRECTORY_DISCOVERY_UNSUPPORTED");
    const data = await request(url.toString(), { headers: { Authorization: `Bearer ${await token()}` } });
    const validated = input.type === "MICROSOFT_ENTRA"
      ? z.object({ value: z.array(z.record(z.string(), z.unknown())).max(100), "@odata.nextLink": z.string().max(8192).optional() }).parse(data)
      : z.object({ users: z.array(z.record(z.string(), z.unknown())).max(100).optional(), nextPageToken: z.string().max(8192).optional() }).parse(data);
    return "value" in validated
      ? { items: validated.value, next: validated["@odata.nextLink"] }
      : { items: validated.users ?? [], next: validated.nextPageToken };
  };

  return {
    async testConnection() {
      if (input.type !== "OIDC_GENERIC") { await page(); return; }
      if (!config.issuer) throw new ProviderManagementFailure("OIDC_ISSUER_REQUIRED");
      if (config.issuer !== input.externalScopeId) throw new ProviderManagementFailure("OIDC_METADATA_MISMATCH");
      const issuer = new URL(config.issuer);
      const allowlist = (process.env.LUXIA_OIDC_ALLOWED_ISSUERS ?? "").split(",").map(value => value.trim());
      if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash ||
          !allowlist.includes(config.issuer)) throw new ProviderManagementFailure("OIDC_ISSUER_NOT_APPROVED");
      const metadata = z.object({ issuer: z.string(), authorization_endpoint: z.string().url(),
        token_endpoint: z.string().url(), jwks_uri: z.string().url() }).parse(
          await oidcMetadataRequest(`${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`));
      if (metadata.issuer !== config.issuer || [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]
        .some(value => new URL(value).protocol !== "https:")) throw new ProviderManagementFailure("OIDC_METADATA_MISMATCH");
    },
    async *discover() {
      const seen = new Set<string>(); let next: string | undefined; let count = 0;
      for (let pages = 0; pages < 10; pages++) {
        const result = await page(next);
        for (const raw of result.items) {
          if (++count > 1000) throw new ProviderManagementFailure("DISCOVERY_LIMIT_EXCEEDED");
          const projected = applyAttributeMapping(raw, mapping);
          yield input.type === "GOOGLE_WORKSPACE"
            ? { ...projected, externalObjectId: normalizeCloudIdentity("GOOGLE_WORKSPACE",
                z.object({ id: z.string(), primaryEmail: z.string(), name: z.object({ fullName: z.string() }).optional() }).parse(raw),
                input.externalScopeId).ref.externalObjectId }
            : projected;
        }
        if (!result.next) return;
        if (seen.has(result.next)) throw new ProviderManagementFailure("PROVIDER_CURSOR_REPLAY");
        seen.add(result.next); next = result.next;
      }
      throw new ProviderManagementFailure("DISCOVERY_LIMIT_EXCEEDED");
    },
  };
}
