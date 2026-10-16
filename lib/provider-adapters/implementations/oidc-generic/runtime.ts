import { UnconfiguredSecretStore } from "../../infrastructure/secret-stores/unconfigured";
import { OpenIdClientOidcGateway } from "../oidc";
import { PrismaGenericOidcConfigResolver } from "./connection-config";
import { GenericOidcAuthenticationProvider } from "./generic-oidc-provider";

// Composition root of generic OIDC sign-in (F4, S4). The client secret is only ever read by reference from the vault;
// until the vault is wired (an operator decision), the store refuses every read, so no generic connection can sign in.
const secrets = new UnconfiguredSecretStore();
const provider = new GenericOidcAuthenticationProvider(new PrismaGenericOidcConfigResolver(), new OpenIdClientOidcGateway(secrets));

export function getGenericOidcAuthenticationProvider(): GenericOidcAuthenticationProvider {
  return provider;
}
