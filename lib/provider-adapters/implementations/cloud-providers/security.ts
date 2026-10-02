import { ProviderAdapterError, type ProviderOperationContext } from "../..";
import type { CloudProviderConfig, CloudProviderType } from "./types";
export function validateCloudProviderConfig(config: CloudProviderConfig, context: ProviderOperationContext, type: CloudProviderType): void {
  if (config.organizationId !== context.organizationId || config.tenantId !== context.tenantId ||
      config.providerConnectionId !== context.providerConnectionId || config.type !== type) invalid("Cloud provider configuration scope mismatch");
  let url: URL; try { url = new URL(config.apiBaseUrl); } catch { invalid("Cloud provider API URL is invalid"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) invalid("Cloud provider API requires credential-free HTTPS URL");
  if (!config.externalScopeId.trim() || !config.credential.key.trim()) invalid("Cloud provider configuration is incomplete");
  if (!bounded(config.connectTimeoutMs, 100, 10_000) || !bounded(config.operationTimeoutMs, 100, 30_000) ||
      !bounded(config.maximumRetries, 0, 3) || !bounded(config.initialBackoffMs, 0, 5_000) || !bounded(config.pageSize, 1, 1_000))
    invalid("Cloud provider safety limits are invalid");
}
function bounded(value: number, min: number, max: number) { return Number.isInteger(value) && value >= min && value <= max; }
function invalid(message: string): never { throw new ProviderAdapterError({ code: "MISCONFIGURED", message }); }
