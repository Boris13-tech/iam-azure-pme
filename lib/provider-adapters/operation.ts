import type { ProviderCapability } from "./capabilities";
import type { ProviderErrorCode, SafeErrorDetails } from "./errors";
import type { ProviderOperationContext } from "./types";

export type ProviderOperationState =
  | "PENDING"
  | "RUNNING"
  | "APPLIED"
  | "RETRYABLE_FAILURE"
  | "PERMANENT_FAILURE"
  | "CONFLICT";

export type ProviderOperationEnvelope<TCommand> = Readonly<{
  context: ProviderOperationContext;
  capability: ProviderCapability;
  command: TCommand;
  /** Stable hash of the canonical command, excluding secrets. */
  requestFingerprint: string;
  createdAt: string;
}>;

export type IdempotencyReservation = Readonly<
  | { disposition: "CREATED"; state: "PENDING" }
  | {
      disposition: "REPLAY";
      state: ProviderOperationState;
      result?: unknown;
    }
>;

export type ProviderOperationFailure = Readonly<{
  code: ProviderErrorCode;
  retryable: boolean;
  safeDetails?: SafeErrorDetails;
}>;

/**
 * Persistence port for durable at-least-once delivery. A reused operationId
 * with a different fingerprint must raise ProviderIdempotencyConflictError.
 */
export interface ProviderOperationJournal {
  reserve<TCommand>(
    operation: ProviderOperationEnvelope<TCommand>,
  ): Promise<IdempotencyReservation>;
  markRunning(context: ProviderOperationContext): Promise<void>;
  markApplied(
    context: ProviderOperationContext,
    result: unknown,
  ): Promise<void>;
  markFailed(
    context: ProviderOperationContext,
    failure: ProviderOperationFailure,
  ): Promise<void>;
}
