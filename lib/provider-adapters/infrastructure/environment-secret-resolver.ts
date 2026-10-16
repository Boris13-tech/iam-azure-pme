import {
  ProviderAdapterError,
  SecretLease,
  assertProviderOperationContext,
  type ProviderOperationContext,
  type SecretReference,
  type SecretResolver,
} from "..";

// Development and tests only: Production refuses it (secret-stores/runtime-guard.ts, F3).
export class EnvironmentSecretResolver implements SecretResolver {
  readonly kind = "environment";

  async withSecret<T>(
    context: ProviderOperationContext,
    reference: SecretReference,
    consumer: (secret: SecretLease) => Promise<T>,
  ): Promise<T> {
    assertProviderOperationContext(context);
    const value = process.env[reference.key];
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
