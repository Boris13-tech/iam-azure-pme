import type { ProviderOperationContext } from "./types";

export type SecretReference = Readonly<{
  key: string;
  version?: string;
}>;

const nodeInspectSymbol = Symbol.for("nodejs.util.inspect.custom");

/**
 * A short-lived secret lease. Its string and JSON representations are always
 * redacted. Consumers must not retain the bytes beyond the resolver callback.
 */
export class SecretLease {
  private value: Uint8Array;
  private disposed = false;

  constructor(value: Uint8Array) {
    this.value = value.slice();
  }

  read<T>(consumer: (secret: Uint8Array) => T): T {
    if (this.disposed) {
      throw new Error("Secret lease has been disposed");
    }

    const copy = this.value.slice();
    try {
      return consumer(copy);
    } finally {
      copy.fill(0);
    }
  }

  async use<T>(
    consumer: (secret: Uint8Array) => Promise<T> | T,
  ): Promise<T> {
    if (this.disposed) {
      throw new Error("Secret lease has been disposed");
    }

    const copy = this.value.slice();
    try {
      return await consumer(copy);
    } finally {
      copy.fill(0);
    }
  }

  dispose(): void {
    this.value.fill(0);
    this.disposed = true;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  [nodeInspectSymbol](): string {
    return "[REDACTED]";
  }
}

export interface SecretResolver {
  withSecret<T>(
    context: ProviderOperationContext,
    reference: SecretReference,
    consumer: (secret: SecretLease) => Promise<T>,
  ): Promise<T>;
}
