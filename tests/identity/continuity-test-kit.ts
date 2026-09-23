import { generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import type {
  ContinuityEvent, ContinuityScope, ContinuityState, DetachedContinuitySignature, IdentityContinuityStore,
  LocalCredentialCheckpoint, SignedAssuranceSnapshot, StoredContinuityConflict, StoredOfflineChallenge, ContinuitySignatureProvider, ContinuitySignatureUsage,
} from "../../lib/identity";

export const scope = Object.freeze({ organizationId: "org-a", tenantId: "tenant-a" });
export const offlineState = (): ContinuityState => ({ ...scope, mode: "OFFLINE", partitionEpoch: 3, sequence: 0,
  enteredAt: "2026-09-23T12:00:00.000Z", lastConnectedAt: "2026-09-23T11:00:00.000Z" });

export class MemoryContinuityStore implements IdentityContinuityStore {
  state: ContinuityState | null = offlineState();
  challenges = new Map<string, StoredOfflineChallenge>(); snapshots = new Map<string, SignedAssuranceSnapshot>();
  events: ContinuityEvent[] = []; conflicts: StoredContinuityConflict[] = [];
  checkpoint: LocalCredentialCheckpoint | null = { subjectId: "subject-a", lifecycleState: "ACTIVE", lifecycleVersion: 4,
    credentialId: "credential-a", credentialState: "ACTIVE", credentialStateVersion: 8 };
  async getState(s: ContinuityScope) { return matches(s, this.state) ? this.state : null; }
  async saveState(s: ContinuityScope, expected: number, next: ContinuityState) {
    if (!matches(s, next) || (this.state && this.state.sequence !== expected)) return false; this.state = next; return true;
  }
  async commitStateTransition(s: ContinuityScope, expected: number, next: ContinuityState, event: ContinuityEvent) {
    if (!matches(s, next) || !matches(s, event) || !this.state || this.state.sequence !== expected) return false;
    this.state = next; this.events.push(event); return true;
  }
  async reserveSequence(s: ContinuityScope, epoch: number) {
    if (!this.state || !matches(s, this.state) || this.state.partitionEpoch !== epoch) throw new Error("EPOCH_MISMATCH");
    this.state = { ...this.state, sequence: this.state.sequence + 1 }; return this.state.sequence;
  }
  async saveChallenge(s: ContinuityScope, value: StoredOfflineChallenge) { assertScope(s, value); this.challenges.set(key(s, value.id), value); }
  async getChallenge(s: ContinuityScope, id: string) { return this.challenges.get(key(s, id)) ?? null; }
  async consumeChallenge(s: ContinuityScope, id: string, now: string) {
    const mapKey = key(s, id), value = this.challenges.get(mapKey);
    if (!value || value.consumedAt || Date.parse(value.expiresAt) <= Date.parse(now)) return false;
    this.challenges.set(mapKey, { ...value, consumedAt: now }); return true;
  }
  async getLocalCredentialCheckpoint(_s: ContinuityScope, subjectId: string, credentialId: string, _now: string) {
    return this.checkpoint?.subjectId === subjectId && this.checkpoint.credentialId === credentialId ? this.checkpoint : null;
  }
  async saveSnapshot(s: ContinuityScope, value: SignedAssuranceSnapshot) { assertScope(s, value.payload); this.snapshots.set(key(s, value.payload.snapshotId), value); }
  async appendEvent(s: ContinuityScope, value: ContinuityEvent) { assertScope(s, value); this.events.push(value); }
  async saveConflict(s: ContinuityScope, value: StoredContinuityConflict) { assertScope(s, value); this.conflicts.push(value); }
}

export class TestContinuityCrypto implements ContinuitySignatureProvider {
  private readonly keys = new Map<string, { privateKey: KeyObject; publicKey: KeyObject }>();
  constructor() { this.add("continuity-issuer"); this.add("credential-a"); }
  add(id: string) { this.keys.set(id, generateKeyPairSync("ec", { namedCurve: "prime256v1" })); }
  async sign(payload: Uint8Array, _usage: ContinuitySignatureUsage, keyId = "continuity-issuer"): Promise<DetachedContinuitySignature> {
    const pair = this.keys.get(keyId); if (!pair) throw new Error("KEY_UNAVAILABLE");
    return { algorithmId: "EVIDENCE_ES256", algorithmVersion: 1, keyId, keyVersion: 1,
      value: sign("sha256", payload, pair.privateKey).toString("base64url") };
  }
  async verify(payload: Uint8Array, signature: DetachedContinuitySignature, _usage: ContinuitySignatureUsage) {
    const pair = this.keys.get(signature.keyId); return !!pair && verify("sha256", payload, pair.publicKey, Buffer.from(signature.value, "base64url"));
  }
}

function key(s: ContinuityScope, id: string) { return `${s.organizationId}\0${s.tenantId}\0${id}`; }
function matches(s: ContinuityScope, value: { organizationId: string; tenantId: string } | null): boolean {
  return !!value && s.organizationId === value.organizationId && s.tenantId === value.tenantId;
}
function assertScope(s: ContinuityScope, value: { organizationId: string; tenantId: string }): void {
  if (!matches(s, value)) throw new Error("INVALID_SCOPE");
}
