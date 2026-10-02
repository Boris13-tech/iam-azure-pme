import { ProviderAdapterError } from "../..";
import type { EnterpriseDirectoryConfig } from "./types";

export function validateDirectoryConfig(config: EnterpriseDirectoryConfig, expected: Readonly<{
  organizationId: string; tenantId: string; providerConnectionId: string; type: string }>): void {
  if (config.organizationId !== expected.organizationId || config.tenantId !== expected.tenantId ||
      config.providerConnectionId !== expected.providerConnectionId || config.type !== expected.type)
    invalid("Directory configuration scope mismatch");
  if (!config.host.trim() || /[\s\0]/.test(config.host) || !config.baseDn.trim() || !config.bindIdentity.trim() || !config.bindSecret.key.trim())
    invalid("Directory connection configuration is incomplete");
  if (config.transport !== "LDAPS" && config.transport !== "STARTTLS") invalid("Encrypted LDAP transport is required");
  if (config.certificateValidation !== "SYSTEM" && config.certificateValidation !== "PINNED") invalid("Certificate validation is required");
  if (config.certificateValidation === "PINNED" && !/^sha256:[A-Za-z0-9_-]{32,}$/.test(config.pinnedCertificateSha256 ?? ""))
    invalid("Pinned certificate digest is invalid");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
      !bounded(config.connectTimeoutMs, 100, 10_000) || !bounded(config.operationTimeoutMs, 100, 30_000) ||
      !bounded(config.maximumRetries, 0, 3) || !bounded(config.pageSize, 1, 1_000)) invalid("Directory connection limits are invalid");
}

/** RFC 4515 value escaping. Never interpolate unescaped values into filters. */
export function escapeLdapFilterValue(value: string): string {
  if (!value || value.length > 1024) invalid("Directory identity key is invalid");
  return value.replace(/[\\*()\u0000]/g, (character) => `\\${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function bounded(value: number, min: number, max: number): boolean { return Number.isInteger(value) && value >= min && value <= max; }
function invalid(message: string): never { throw new ProviderAdapterError({ code: "MISCONFIGURED", message }); }
