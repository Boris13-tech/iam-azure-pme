import {
  ProviderAdapterError,
  SecretLease,
  assertProviderOperationContext,
  type ProviderOperationContext,
  type SecretReference,
  type SecretResolver,
} from "..";
import { parseSecretReference } from "./secret-stores/reference";

// Development and tests only: Production refuses it (secret-stores/runtime-guard.ts, F3).
export class EnvironmentSecretResolver implements SecretResolver {
  readonly kind = "environment";

  async withSecret<T>(
    context: ProviderOperationContext,
    reference: SecretReference,
    consumer: (secret: SecretLease) => Promise<T>,
  ): Promise<T> {
    assertProviderOperationContext(context);
    const key = typeof reference?.key === "string" ? reference.key : "";
    if (key.startsWith("akv://")) {
      throw new ProviderAdapterError({
        code: "SECRET_UNAVAILABLE",
        message: "Vault secret references cannot be resolved from process environment",
        safeDetails: {
          providerConnectionId: context.providerConnectionId,
          reason: "INVALID_SECRET_STORE",
        },
      });
    }
    const envName = key.startsWith("env://") ? parseSecretReference(reference).name : key;
    const value = envName ? process.env[envName] : undefined;
    if (!value) {
      throw new ProviderAdapterError({
        code: "SECRET_UNAVAILABLE",
        message: "Required provider credential is unavailable",
        safeDetails: {
          providerConnectionId: context.providerConnectionId,
          secretReference: reference.key,
        },
      });
    }

    const lease = new SecretLease(new TextEncoder().encode(value));
    try {
      return await consumer(lease);
    } finally {
      lease.dispose();
    }
  }
}