import {
  ProviderAdapterError,
  assertProviderOperationContext,
  type ProviderOperationContext,
} from "../..";
import { withTenantDb } from "../../../db/scoped-client";
import { connectionSecretReference } from "../../infrastructure/secret-stores/connection-references";
import type { OidcClientConfig } from "../oidc";
import type { GenericOidcConfigResolver, GenericOidcConnectionConfig } from "./generic-oidc-provider";

// F4, slice S4: a generic connection's configuration, read inside the organization's scope (forced row-level security
// on both tables), only for an OIDC_GENERIC connection that covers the requested tenant. The client secret is the
// connection's live F3 reference (purpose OIDC_CLIENT, pinned active version): no reference means no sign-in, and there
// is never a fallback to a global variable. No status check here: the callers gate on the connection's status.
export class PrismaGenericOidcConfigResolver implements GenericOidcConfigResolver {
  async resolve(context: ProviderOperationContext): Promise<GenericOidcConnectionConfig> {
    assertProviderOperationContext(context);
    const configuration = await withTenantDb({ organizationId: context.organizationId, tenantId: context.tenantId }, (tx) =>
      tx.providerOidcConfiguration.findFirst({
        where: {
          organizationId: context.organizationId,
          providerConnectionId: context.providerConnectionId,
          providerConnection: {
            providerType: "OIDC_GENERIC",
            tenantScopes: { some: { organizationId: context.organizationId, tenantId: context.tenantId } },
          },
        },
        select: { issuer: true, clientId: true, clientAuthMethod: true, idTokenAlgorithm: true, scopes: true, configurationHash: true },
      }));
    if (!configuration) misconfigured(context, "CONNECTION_NOT_CONFIGURED");
    const clientSecret = await connectionSecretReference(context, "OIDC_CLIENT", "active");
    if (!clientSecret) misconfigured(context, "SECRET_REFERENCE_MISSING");
    const client: OidcClientConfig = {
      issuer: configuration.issuer,
      clientId: configuration.clientId,
      clientSecret,
      redirectUri: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/auth/callback`,
      scope: configuration.scopes,
      // The database holds these to the same three algorithms and two methods (S2 CHECK constraints).
      idTokenAlgorithm: configuration.idTokenAlgorithm as OidcClientConfig["idTokenAlgorithm"],
      clientAuthMethod: configuration.clientAuthMethod as OidcClientConfig["clientAuthMethod"],
    };
    return { client, configurationHash: configuration.configurationHash };
  }
}

function misconfigured(context: ProviderOperationContext, reason: string): never {
  throw new ProviderAdapterError({
    code: "MISCONFIGURED",
    message: "OIDC connection is not configured",
    safeDetails: { providerConnectionId: context.providerConnectionId, reason },
  });
}
