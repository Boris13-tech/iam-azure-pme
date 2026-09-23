import { randomUUID } from "node:crypto";
import { ContinuitySecurityError, continuityDigest, transitionContinuityMode, type ContinuityMode, type ContinuityState } from "./continuity";
import type { ContinuityScope, IdentityContinuityStore } from "./continuity-store";

export async function commitContinuityModeTransition(input: Readonly<{
  scope: ContinuityScope; current: ContinuityState; nextMode: ContinuityMode; operationId: string;
  now?: Date; reconciliationComplete?: boolean;
}>, store: IdentityContinuityStore): Promise<ContinuityState> {
  const occurredAt = (input.now ?? new Date()).toISOString();
  const next = transitionContinuityMode(input.current, input.nextMode, occurredAt, input.reconciliationComplete);
  if (next === input.current) return next;
  const event = { id: randomUUID(), ...input.scope, eventType: "MODE_TRANSITION" as const, mode: next.mode,
    partitionEpoch: next.partitionEpoch, sequence: next.sequence, operationId: input.operationId,
    reasonCode: `${input.current.mode}_TO_${next.mode}`, evidenceDigest: continuityDigest({ from: input.current, to: next }), occurredAt };
  if (!await store.commitStateTransition(input.scope, input.current.sequence, next, event))
    throw new ContinuitySecurityError("CONFLICT_QUARANTINED");
  return next;
}
