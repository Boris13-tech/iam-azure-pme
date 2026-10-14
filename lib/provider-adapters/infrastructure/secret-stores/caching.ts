import {
  ProviderAdapterError,
  SecretLease,
  assertProviderOperationContext,
  type ProviderOperationContext,
  type SecretReference,
  type SecretResolver,
} from "../..";

// F3 resilience (design section 6): a short cache in front of a remote store, so that sign-ins do not depend on the
// store for every request, and a bounded "stale if error" window, so that a store outage does not stop a connection
// whose secret was read recently. Only transient failures (retryable) are bridged: a denied, missing, disabled or
// invalid secret evicts the entry and fails closed at once. Entries are per organization and per connection; their
// bytes are zeroed when evicted.
type Entry = { bytes: Uint8Array; fetchedAt: number };

export class CachingSecretResolver implements SecretResolver {
  readonly kind: string;
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly staleIfErrorMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(private readonly inner: SecretResolver & { kind?: string }, options: { ttlMs?: number; staleIfErrorMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.kind = inner.kind ?? "unknown";
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.staleIfErrorMs = options.staleIfErrorMs ?? 60 * 60_000;
    this.maxEntries = options.maxEntries ?? 256;
    this.now = options.now ?? Date.now;
  }

  async withSecret<T>(context: ProviderOperationContext, reference: SecretReference, consumer: (secret: SecretLease) => Promise<T>): Promise<T> {
    assertProviderOperationContext(context);
    const key = [context.organizationId, context.providerConnectionId, reference.key, reference.version ?? ""].join("\u0000");
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.fetchedAt < this.ttlMs) return this.serve(entry, consumer);
    let fresh: Uint8Array;
    try {
      fresh = await this.inner.withSecret(context, reference, async (lease) => lease.read((bytes) => bytes.slice()));
    } catch (error) {
      const transient = error instanceof ProviderAdapterError && error.retryable;
      if (transient && entry && this.now() - entry.fetchedAt < this.staleIfErrorMs) return this.serve(entry, consumer);
      if (!transient) this.evict(key);
      throw error;
    }
    this.evict(key);
    this.entries.set(key, { bytes: fresh, fetchedAt: this.now() });
    while (this.entries.size > this.maxEntries) this.evict(this.entries.keys().next().value as string);
    return this.serve(this.entries.get(key)!, consumer);
  }

  /** Drops every cached value (rotation, quarantine, tests). */
  clear(): void {
    for (const key of [...this.entries.keys()]) this.evict(key);
  }

  private async serve<T>(entry: Entry, consumer: (secret: SecretLease) => Promise<T>): Promise<T> {
    const lease = new SecretLease(entry.bytes);
    try { return await consumer(lease); } finally { lease.dispose(); }
  }

  private evict(key: string): void {
    const entry = this.entries.get(key);
    if (entry) { entry.bytes.fill(0); this.entries.delete(key); }
  }
}
