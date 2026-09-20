import type { ProviderCapability } from "./capabilities";
import type { ProviderTypeId } from "./types";

export const PROVIDER_ERROR_CODES = [
  "INVALID_SCOPE",
  "INVALID_REQUEST",
  "MISCONFIGURED",
  "AUTHENTICATION_FAILED",
  "AUTHORIZATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "UNAVAILABLE",
  "TIMEOUT",
  "UNSUPPORTED_CAPABILITY",
  "IDEMPOTENCY_CONFLICT",
  "SECRET_UNAVAILABLE",
  "INTERNAL",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];
export type SafeErrorDetails = Readonly<
  Record<string, string | number | boolean | null>
>;

export class ProviderAdapterError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly safeDetails: SafeErrorDetails;

  constructor(options: {
    code: ProviderErrorCode;
    message: string;
    retryable?: boolean;
    safeDetails?: SafeErrorDetails;
  }) {
    super(options.message);
    this.name = "ProviderAdapterError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.safeDetails = Object.freeze({ ...(options.safeDetails ?? {}) });
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      safeDetails: this.safeDetails,
    };
  }
}

export class UnsupportedProviderCapabilityError extends ProviderAdapterError {
  constructor(providerType: ProviderTypeId, capability: ProviderCapability) {
    super({
      code: "UNSUPPORTED_CAPABILITY",
      message: `Provider '${providerType}' does not support '${capability}'`,
      safeDetails: { providerType, capability },
    });
    this.name = "UnsupportedProviderCapabilityError";
  }
}

export class ProviderIdempotencyConflictError extends ProviderAdapterError {
  constructor(operationId: string) {
    super({
      code: "IDEMPOTENCY_CONFLICT",
      message: "Provider operation id was reused with different semantics",
      safeDetails: { operationId },
    });
    this.name = "ProviderIdempotencyConflictError";
  }
}

export class ProviderRegistryError extends ProviderAdapterError {
  constructor(code: "NOT_FOUND" | "CONFLICT", message: string) {
    super({ code, message });
    this.name = "ProviderRegistryError";
  }
}
