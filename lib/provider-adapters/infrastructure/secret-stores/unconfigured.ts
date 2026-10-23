import {
  ProviderAdapterError,
  assertProviderOperationContext,
  type ProviderOperationContext,
  type SecretReference,
  type SecretResolver,
} from "../..";
import { parseSecretReference } from "./reference";

// F3/F4: the store behind per-connection references until the vault is wired (operator decisions KV1 to KV6). Every
// read fails closed: until then no generic OIDC connection can sign in, and nothing ever falls back to the process
// environment. The vault resolver replaces it at the composition root, by an operator decision.
export class UnconfiguredSecretStore implements SecretResolver {
  readonly kind = "unconfigured";

  async withSecret<T>(context: ProviderOperationContext, reference: SecretReference): Promise<T> {
    assertProviderOperationContext(context);
    parseSecretReference(reference);
    throw new ProviderAdapterError({
      code: "SECRET_UNAVAILABLE",
      message: "Provider credential store is not configured",
      safeDetails: { reason: "STORE_NOT_CONFIGURED" },
    });
  }
}
