import { randomUUID } from "node:crypto";
import { ContinuitySecurityError, continuityDigest, type ContinuityMode } from "./continuity";
import type { ContinuityEvent, ContinuityScope, StoredContinuityConflict } from "./continuity-store";

export type ReconciliationSecurityState = "ACTIVE" | "SUSPENDED" | "DISABLED" | "REVOKED" | "COMPROMISED" | "RETIRED";
export type ReconciliationEntity = Readonly<{
  entityType: "SUBJECT" | "IDENTITY_ACCOUNT" | "CREDENTIAL";
  entityId: string;
  subjectId: string;
  version: number;
  securityState: ReconciliationSecurityState;
  digest: string;
  source: "LOCAL" | "PROVIDER";
}>;
export type ReconciliationAction = Readonly<{
  entityType: ReconciliationEntity["entityType"]; entityId: string;
  action: "NO_CHANGE" | "PRESERVE_CANONICAL_SUBJECT" | "APPLY_RESTRICTIVE_REMOTE_STATE" | "KEEP_RESTRICTIVE_LOCAL_STATE" | "QUARANTINE";
  reasonCode: string;
}>;
export type ContinuityReconciliationResult = Readonly<{
  actions: ReadonlyArray<ReconciliationAction>;
  conflicts: ReadonlyArray<StoredContinuityConflict>;
  readyForConnected: boolean;
  privilegeIncreaseApplied: false;
  event: ContinuityEvent;
}>;

const restrictionRank: Readonly<Record<ReconciliationSecurityState, number>> = {
  ACTIVE: 0, SUSPENDED: 1, DISABLED: 2, REVOKED: 3, COMPROMISED: 4, RETIRED: 5,
};

export function reconcileIdentityContinuity(input: Readonly<{
  scope: ContinuityScope; mode: ContinuityMode; partitionEpoch: number; sequence: number; operationId: string;
  local: ReadonlyArray<ReconciliationEntity>; remote: ReadonlyArray<ReconciliationEntity>; now?: Date;
}>): ContinuityReconciliationResult {
  if (input.mode !== "RECOVERING") throw new ContinuitySecurityError("INVALID_MODE_TRANSITION");
  const local = index(input.local, input.scope, "LOCAL"); const remote = index(input.remote, input.scope, "PROVIDER");
  const actions: ReconciliationAction[] = []; const conflicts: StoredContinuityConflict[] = [];
  for (const key of [...new Set([...local.keys(), ...remote.keys()])].sort()) {
    const left = local.get(key), right = remote.get(key);
    if (left?.entityType === "SUBJECT") {
      actions.push({ entityType: "SUBJECT", entityId: left.entityId, action: "PRESERVE_CANONICAL_SUBJECT", reasonCode: "CANONICAL_SUBJECT_PROVIDER_INDEPENDENT" });
      if (right && left.digest !== right.digest) conflicts.push(conflict(input.scope, left, right, "CANONICAL_SUBJECT_CONFLICT"));
      continue;
    }
    if (!left && right) {
      actions.push({ entityType: right.entityType, entityId: right.entityId, action: "QUARANTINE", reasonCode: "REMOTE_ADDITION_REQUIRES_REVIEW" });
      conflicts.push(conflict(input.scope, emptyLocal(right), right, "REMOTE_ADDITION_REQUIRES_REVIEW"));
      continue;
    }
    if (left && !right) {
      if (left.entityType === "IDENTITY_ACCOUNT" && left.securityState === "ACTIVE") {
        actions.push({ entityType: left.entityType, entityId: left.entityId, action: "QUARANTINE", reasonCode: "PROVIDER_PROJECTION_OMISSION_REQUIRES_REVIEW" });
        conflicts.push(conflict(input.scope, left, emptyRemote(left), "PROVIDER_PROJECTION_OMISSION_REQUIRES_REVIEW"));
      } else {
        actions.push({ entityType: left.entityType, entityId: left.entityId,
          action: restrictionRank[left.securityState] > 0 ? "KEEP_RESTRICTIVE_LOCAL_STATE" : "NO_CHANGE",
          reasonCode: "REMOTE_OMISSION_CANNOT_DELETE_CANONICAL_LOCAL_STATE" });
      }
      continue;
    }
    if (!left || !right) continue;
    if (left.digest === right.digest && left.version === right.version) {
      actions.push({ entityType: left.entityType, entityId: left.entityId, action: "NO_CHANGE", reasonCode: "STATE_MATCH" }); continue;
    }
    const localRank = restrictionRank[left.securityState], remoteRank = restrictionRank[right.securityState];
    if (remoteRank > localRank && right.version >= left.version) {
      actions.push({ entityType: left.entityType, entityId: left.entityId, action: "APPLY_RESTRICTIVE_REMOTE_STATE", reasonCode: "RESTRICTIVE_STATE_WINS" }); continue;
    }
    if (localRank > remoteRank) {
      actions.push({ entityType: left.entityType, entityId: left.entityId, action: "KEEP_RESTRICTIVE_LOCAL_STATE", reasonCode: "NO_OFFLINE_PRIVILEGE_RESTORE" }); continue;
    }
    actions.push({ entityType: left.entityType, entityId: left.entityId, action: "QUARANTINE", reasonCode: "CONCURRENT_SECURITY_STATE_CONFLICT" });
    conflicts.push(conflict(input.scope, left, right, "CONCURRENT_SECURITY_STATE_CONFLICT"));
  }
  const now = (input.now ?? new Date()).toISOString(); const readyForConnected = conflicts.length === 0;
  const summary = { actions, conflictIds: conflicts.map((item) => item.id), readyForConnected };
  const event: ContinuityEvent = { id: randomUUID(), ...input.scope, eventType: readyForConnected ? "RECONCILIATION_COMPLETED" : "RECONCILIATION_CONFLICT",
      mode: "RECOVERING", partitionEpoch: input.partitionEpoch, sequence: input.sequence + 1, operationId: input.operationId,
      reasonCode: readyForConnected ? "DETERMINISTIC_RECONCILIATION_COMPLETE" : "SECURITY_CONFLICTS_QUARANTINED",
      evidenceDigest: continuityDigest(summary), occurredAt: now };
  return Object.freeze({ actions, conflicts, readyForConnected, privilegeIncreaseApplied: false, event });
}

function index(items: ReadonlyArray<ReconciliationEntity>, scope: ContinuityScope, source: ReconciliationEntity["source"]): Map<string, ReconciliationEntity> {
  const output = new Map<string, ReconciliationEntity>();
  for (const item of items) {
    if (item.source !== source || item.version < 0 || !item.entityId.trim() || !item.subjectId.trim()) throw new ContinuitySecurityError("INVALID_SCOPE");
    const key = `${item.entityType}\0${item.entityId}`; if (output.has(key)) throw new ContinuitySecurityError("CONFLICT_QUARANTINED");
    output.set(key, item);
  }
  if (!scope.organizationId.trim() || !scope.tenantId.trim()) throw new ContinuitySecurityError("INVALID_SCOPE");
  return output;
}
function conflict(scope: ContinuityScope, local: ReconciliationEntity, remote: ReconciliationEntity, reasonCode: string): StoredContinuityConflict {
  return { id: randomUUID(), ...scope, subjectId: local.subjectId || remote.subjectId, entityType: local.entityType,
    entityId: local.entityId, localVersion: local.version, remoteVersion: remote.version,
    localDigest: local.digest, remoteDigest: remote.digest, reasonCode };
}
function emptyLocal(remote: ReconciliationEntity): ReconciliationEntity {
  return { ...remote, version: 0, securityState: "DISABLED", digest: continuityDigest({ missing: true }), source: "LOCAL" };
}
function emptyRemote(local: ReconciliationEntity): ReconciliationEntity {
  return { ...local, version: 0, securityState: "DISABLED", digest: continuityDigest({ missing: true }), source: "PROVIDER" };
}
