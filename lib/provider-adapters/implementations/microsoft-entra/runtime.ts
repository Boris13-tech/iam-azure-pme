import { ProviderAdapterRegistry } from "../..";
import { createRuntimeSecretResolver } from "../../infrastructure/secret-stores";
import { PrismaMicrosoftEntraConnectionConfigResolver } from "./connection-config";
import { MicrosoftGraphGateway } from "./graph-client";
import { MicrosoftEntraAdapter } from "./microsoft-entra-adapter";
import { OpenIdClientMicrosoftEntraGateway } from "./oidc-client";

let cachedRuntime: { modeProd: boolean; workloadKey: string; adapter: MicrosoftEntraAdapter } | null = null;

export function getMicrosoftEntraAdapter(): MicrosoftEntraAdapter {
  const modeProd =
    process.env.VERCEL_ENV === "production" ||
    process.env.APP_ENV === "production" ||
    (process.env.NODE_ENV === "production" &&
      !["preview", "development"].includes(process.env.VERCEL_ENV ?? "") &&
      !["development", "test", "staging", "preview"].includes(process.env.APP_ENV ?? ""));
  const workloadKey = `${process.env.LUXIA_WORKLOAD_TENANT_ID ?? ""}:${process.env.LUXIA_WORKLOAD_CLIENT_ID ?? ""}`;

  if (!cachedRuntime || cachedRuntime.modeProd !== modeProd || cachedRuntime.workloadKey !== workloadKey) {
    const secrets = createRuntimeSecretResolver();
    const adapter = new MicrosoftEntraAdapter(
      new PrismaMicrosoftEntraConnectionConfigResolver(),
      new OpenIdClientMicrosoftEntraGateway(secrets),
      new MicrosoftGraphGateway(secrets),
    );
    const registry = new ProviderAdapterRegistry();
    registry.register(adapter);
    registry.resolveWithCapability("MICROSOFT_ENTRA", "IDENTITY_LIFECYCLE");
    cachedRuntime = { modeProd, workloadKey, adapter };
  }
  return cachedRuntime.adapter;
}
