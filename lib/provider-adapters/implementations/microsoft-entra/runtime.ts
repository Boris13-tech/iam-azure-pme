import { ProviderAdapterRegistry } from "../..";
import { EnvironmentSecretResolver } from "../../infrastructure/environment-secret-resolver";
import { PrismaMicrosoftEntraConnectionConfigResolver } from "./connection-config";
import { MicrosoftGraphGateway } from "./graph-client";
import { MicrosoftEntraAdapter } from "./microsoft-entra-adapter";
import { OpenIdClientMicrosoftEntraGateway } from "./oidc-client";

const secrets = new EnvironmentSecretResolver();
const adapter = new MicrosoftEntraAdapter(
  new PrismaMicrosoftEntraConnectionConfigResolver(),
  new OpenIdClientMicrosoftEntraGateway(secrets),
  new MicrosoftGraphGateway(secrets),
);
const registry = new ProviderAdapterRegistry();
registry.register(adapter);

export function getMicrosoftEntraAdapter(): MicrosoftEntraAdapter {
  registry.resolveWithCapability("MICROSOFT_ENTRA", "IDENTITY_LIFECYCLE");
  return adapter;
}
