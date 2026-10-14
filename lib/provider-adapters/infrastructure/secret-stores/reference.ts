import { ProviderAdapterError, type SecretReference } from "../..";

// F3 (docs/architecture/F3-SECRET-STORE-DESIGN.md): a secret reference is a locator, never a value.
//   akv://<vault>/<secret-name>   Azure Key Vault (version pinned in SecretReference.version)
//   env://<NAME> or <NAME>        process environment: development and tests only (refused in Production)
// Other stores (an EU-hosted OpenBao, another cloud) are added as new schemes behind the same SecretResolver port.
export type ParsedSecretReference =
  | Readonly<{ store: "azure-key-vault"; vault: string; name: string; version?: string }>
  | Readonly<{ store: "environment"; name: string }>;

const VAULT = /^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/;
const KV_SECRET = /^[0-9a-zA-Z-]{1,127}$/;
const KV_VERSION = /^[0-9a-f]{32}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

export function invalidReference(): never {
  throw new ProviderAdapterError({ code: "SECRET_UNAVAILABLE", message: "Invalid secret reference", safeDetails: { reason: "INVALID_REFERENCE" } });
}

export function parseSecretReference(reference: SecretReference): ParsedSecretReference {
  const key = typeof reference?.key === "string" ? reference.key : "";
  const akv = /^akv:\/\/([^/]+)\/([^/]+)$/.exec(key);
  if (akv) {
    const [, vault, name] = akv;
    const version = reference.version;
    if (!VAULT.test(vault) || vault.includes("--") || !KV_SECRET.test(name) || (version !== undefined && !KV_VERSION.test(version))) invalidReference();
    return Object.freeze({ store: "azure-key-vault", vault: vault.toLowerCase(), name, ...(version ? { version } : {}) });
  }
  const name = key.startsWith("env://") ? key.slice("env://".length) : key;
  if (!ENV_NAME.test(name)) invalidReference();
  return Object.freeze({ store: "environment", name });
}
