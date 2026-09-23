import { describe, expect, it } from "vitest";
import { reconcileIdentityContinuity, type ReconciliationEntity } from "../../lib/identity";
import { scope } from "./continuity-test-kit";

const entity = (overrides: Partial<ReconciliationEntity> = {}): ReconciliationEntity => ({ entityType: "CREDENTIAL", entityId: "credential-a",
  subjectId: "subject-a", version: 1, securityState: "ACTIVE", digest: "sha256:one", source: "LOCAL", ...overrides });
const reconcile = (local: ReconciliationEntity[], remote: ReconciliationEntity[]) => reconcileIdentityContinuity({
  scope, mode: "RECOVERING", partitionEpoch: 4, recoveryEpoch: 0, sequence: 10, operationId: "reconcile", local, remote,
  now: new Date("2026-09-23T13:00:00.000Z"),
});

describe("Phase 6F deterministic reconnect reconciliation", () => {
  it("applies only a newer restrictive provider state", () => {
    const result = reconcile([entity()], [entity({ source: "PROVIDER", version: 2, securityState: "REVOKED", digest: "sha256:revoked" })]);
    expect(result).toMatchObject({ readyForConnected: true, privilegeIncreaseApplied: false });
    expect(result.actions[0]).toMatchObject({ action: "APPLY_RESTRICTIVE_REMOTE_STATE", reasonCode: "RESTRICTIVE_STATE_WINS" });
  });

  it("does not let remote ACTIVE state restore a locally revoked credential", () => {
    const result = reconcile([entity({ securityState: "REVOKED", version: 3, digest: "sha256:revoked" })],
      [entity({ source: "PROVIDER", securityState: "ACTIVE", version: 4, digest: "sha256:active" })]);
    expect(result.actions[0]).toMatchObject({ action: "KEEP_RESTRICTIVE_LOCAL_STATE", reasonCode: "NO_OFFLINE_PRIVILEGE_RESTORE" });
    expect(result.privilegeIncreaseApplied).toBe(false);
  });

  it("quarantines concurrent conflicts and never silently last-write-wins", () => {
    const result = reconcile([entity({ version: 4, digest: "sha256:local" })], [entity({ source: "PROVIDER", version: 4, digest: "sha256:remote" })]);
    expect(result.readyForConnected).toBe(false); expect(result.conflicts).toHaveLength(1);
    expect(result.actions[0].action).toBe("QUARANTINE"); expect(result.event.eventType).toBe("RECONCILIATION_CONFLICT");
  });

  it("preserves the canonical Subject even when provider state conflicts", () => {
    const local = entity({ entityType: "SUBJECT", entityId: "subject-a", digest: "sha256:canonical" });
    const result = reconcile([local], [{ ...local, source: "PROVIDER", version: 2, digest: "sha256:provider" }]);
    expect(result.actions[0]).toMatchObject({ action: "PRESERVE_CANONICAL_SUBJECT" });
    expect(result.conflicts[0].reasonCode).toBe("CANONICAL_SUBJECT_CONFLICT");
  });

  it("quarantines a missing active provider projection without deleting its Subject", () => {
    const result = reconcile([entity({ entityType: "IDENTITY_ACCOUNT", entityId: "entra-account" })], []);
    expect(result.actions[0]).toMatchObject({ action: "QUARANTINE", reasonCode: "PROVIDER_PROJECTION_OMISSION_REQUIRES_REVIEW" });
    expect(result.readyForConnected).toBe(false); expect(result.privilegeIncreaseApplied).toBe(false);
  });

  it("is deterministic apart from generated evidence identifiers", () => {
    const local = [entity()], remote = [entity({ source: "PROVIDER" })];
    expect(reconcile(local, remote).actions).toEqual(reconcile(local, remote).actions);
  });
});
