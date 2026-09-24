import { describe, expect, it, vi } from "vitest";
import {
  createOfflineProof, issueAssuranceSnapshot, issueOfflineChallenge, verifyOfflineProof,
  type SignedAssuranceSnapshot, type SignedOfflineChallenge,
} from "../../lib/identity";
import { MemoryContinuityStore, TestContinuityCrypto, offlineState, scope } from "./continuity-test-kit";

const now = new Date("2026-09-23T12:00:00.000Z");
const setup = () => ({ store: new MemoryContinuityStore(), crypto: new TestContinuityCrypto(), state: offlineState() });
const challengeInput = (state = offlineState()) => ({ scope, subjectId: "subject-a", verifierId: "edge-a", audience: "local-app",
  purpose: "interactive-authentication", state, now, nonce: "fresh-256-bit-test-nonce-value-0001" });

describe("Phase 6F signed offline proof", () => {
  it("authenticates locally with the network disabled and emits bounded, non-bearer evidence", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const { store, crypto, state } = setup();
    const challenge = await issueOfflineChallenge(challengeInput(state), store, crypto);
    const proof = await createOfflineProof(challenge, "credential-a", crypto, { now: new Date(now.getTime() + 1_000) });
    const evidence = await verifyOfflineProof({ scope, expectedSubjectId: "subject-a", expectedVerifierId: "edge-a",
      expectedAudience: "local-app", expectedPurpose: "interactive-authentication", state, challenge, proof,
      operationId: "offline-op", now: new Date(now.getTime() + 2_000) }, store, crypto);
    expect(evidence).toMatchObject({ authorizationUse: "EVIDENCE_ONLY", privilegeConstraint: "NO_PRIVILEGE_INCREASE", reusableBearer: false });
    expect(network).not.toHaveBeenCalled(); expect(store.events.map((event) => event.eventType)).toContain("OFFLINE_PROOF_VERIFIED"); network.mockRestore();
  });

  it("rejects replay after restart because consumption is durable in the store", async () => {
    const { store, crypto, state } = setup(); const challenge = await issueOfflineChallenge(challengeInput(state), store, crypto);
    const proof = await createOfflineProof(challenge, "credential-a", crypto, { now: new Date(now.getTime() + 1_000) });
    const request = { scope, expectedSubjectId: "subject-a", expectedVerifierId: "edge-a", expectedAudience: "local-app",
      expectedPurpose: "interactive-authentication", state, challenge, proof, operationId: "op", now: new Date(now.getTime() + 2_000) };
    await verifyOfflineProof(request, store, crypto);
    await expect(verifyOfflineProof({ ...request, operationId: "after-restart" }, store, crypto)).rejects.toThrow("REPLAY_DETECTED");
  });

  it("rejects expired, tampered and cross-tenant challenges", async () => {
    const { store, crypto, state } = setup(); const challenge = await issueOfflineChallenge(challengeInput(state), store, crypto);
    const proof = await createOfflineProof(challenge, "credential-a", crypto, { now: new Date(now.getTime() + 1_000) });
    const base = { scope, expectedSubjectId: "subject-a", expectedVerifierId: "edge-a", expectedAudience: "local-app",
      expectedPurpose: "interactive-authentication", state, challenge, proof, operationId: "op" };
    await expect(verifyOfflineProof({ ...base, now: new Date(now.getTime() + 300_000) }, store, crypto)).rejects.toThrow("EXPIRED");
    const tampered: SignedOfflineChallenge = { ...challenge, payload: { ...challenge.payload, audience: "admin-app" } };
    await expect(verifyOfflineProof({ ...base, challenge: tampered, now: new Date(now.getTime() + 2_000) }, store, crypto)).rejects.toThrow();
    await expect(verifyOfflineProof({ ...base, scope: { ...scope, tenantId: "tenant-b" }, now: new Date(now.getTime() + 2_000) }, store, crypto)).rejects.toThrow("INVALID_SCOPE");
  });

  it("bounds clock skew and rejects a stale partition epoch", async () => {
    const future = setup(); const futureNow = new Date(now.getTime() + 180_000);
    const futureChallenge = await issueOfflineChallenge({ ...challengeInput(future.state), now: futureNow }, future.store, future.crypto);
    const futureProof = await createOfflineProof(futureChallenge, "credential-a", future.crypto, { now: futureNow });
    const base = { scope, expectedSubjectId: "subject-a", expectedVerifierId: "edge-a", expectedAudience: "local-app",
      expectedPurpose: "interactive-authentication", operationId: "clock", now };
    await expect(verifyOfflineProof({ ...base, state: future.state, challenge: futureChallenge, proof: futureProof }, future.store, future.crypto)).rejects.toThrow("FRESHNESS_UNAVAILABLE");

    const epoch = setup(); const epochChallenge = await issueOfflineChallenge(challengeInput(epoch.state), epoch.store, epoch.crypto);
    const epochProof = await createOfflineProof(epochChallenge, "credential-a", epoch.crypto, { now: new Date(now.getTime() + 1_000) });
    await expect(verifyOfflineProof({ ...base, state: { ...epoch.state, partitionEpoch: 4 }, challenge: epochChallenge, proof: epochProof,
      now: new Date(now.getTime() + 2_000) }, epoch.store, epoch.crypto)).rejects.toThrow("EPOCH_MISMATCH");
  });

  it("verifies signed snapshots and rejects tampering, staleness and revocation", async () => {
    const { store, crypto, state } = setup();
    const snapshot = await issueAssuranceSnapshot({ ...scope, subjectId: "subject-a", issuer: "edge-a", audience: "local-app",
      purpose: "interactive-authentication", scope: { providerConnectionIds: ["luxia-local"], credentialIds: ["credential-a"] },
      assurance: { level: "HIGH", profile: "offline-passkey", profileVersion: 1, phishingResistant: true, hardwareBound: true, userVerification: "VERIFIED" },
      evidenceDigests: ["sha256:authentication-evidence"], lifecycleState: "ACTIVE", lifecycleVersion: 4,
      credentialStateVersion: 8, continuityMode: "OFFLINE", partitionEpoch: 3, recoveryEpoch: 0, ttlMs: 60_000, now }, store, crypto);
    const challenge = await issueOfflineChallenge(challengeInput({ ...state, sequence: store.state!.sequence }), store, crypto);
    const proof = await createOfflineProof(challenge, "credential-a", crypto, { now: new Date(now.getTime() + 1_000), snapshot });
    const request = { scope, expectedSubjectId: "subject-a", expectedVerifierId: "edge-a", expectedAudience: "local-app",
      expectedPurpose: "interactive-authentication", state: { ...state, sequence: store.state!.sequence }, challenge, proof, snapshot,
      operationId: "snapshot-op", now: new Date(now.getTime() + 2_000) };
    await expect(verifyOfflineProof(request, store, crypto)).resolves.toMatchObject({ snapshotId: snapshot.payload.snapshotId });

    const second = setup(); const nextChallenge = await issueOfflineChallenge(challengeInput(second.state), second.store, second.crypto);
    const tamperedSnapshot: SignedAssuranceSnapshot = { ...snapshot, payload: { ...snapshot.payload, assurance: { ...snapshot.payload.assurance, level: "LOW" } } };
    const tamperedProof = await createOfflineProof(nextChallenge, "credential-a", second.crypto, { now: new Date(now.getTime() + 1_000), snapshot: tamperedSnapshot });
    await expect(verifyOfflineProof({ ...request, state: second.state, challenge: nextChallenge, proof: tamperedProof, snapshot: tamperedSnapshot }, second.store, second.crypto)).rejects.toThrow("SIGNATURE_INVALID");

    const third = setup(); const staleChallenge = await issueOfflineChallenge(challengeInput(third.state), third.store, third.crypto);
    const staleProof = await createOfflineProof(staleChallenge, "credential-a", third.crypto, { now: new Date(now.getTime() + 1_000), snapshot });
    third.store.checkpoint = { ...third.store.checkpoint!, credentialStateVersion: 9 };
    await expect(verifyOfflineProof({ ...request, state: third.state, challenge: staleChallenge, proof: staleProof }, third.store, third.crypto)).rejects.toThrow("STALE_EVIDENCE");

    const fourth = setup(); const expiredChallenge = await issueOfflineChallenge(challengeInput(fourth.state), fourth.store, fourth.crypto);
    const expiredProof = await createOfflineProof(expiredChallenge, "credential-a", fourth.crypto, { now: new Date(now.getTime() + 1_000), snapshot });
    await expect(verifyOfflineProof({ ...request, state: fourth.state, challenge: expiredChallenge, proof: expiredProof,
      now: new Date(now.getTime() + 60_000) }, fourth.store, fourth.crypto)).rejects.toThrow("EXPIRED");

    const fifth = setup(); const revokedChallenge = await issueOfflineChallenge(challengeInput(fifth.state), fifth.store, fifth.crypto);
    const revokedProof = await createOfflineProof(revokedChallenge, "credential-a", fifth.crypto, { now: new Date(now.getTime() + 1_000) });
    fifth.store.checkpoint = { ...fifth.store.checkpoint!, credentialState: "REVOKED", credentialStateVersion: 9 };
    await expect(verifyOfflineProof({ ...request, state: fifth.state, challenge: revokedChallenge, proof: revokedProof, snapshot: undefined }, fifth.store, fifth.crypto)).rejects.toThrow("STALE_EVIDENCE");
  });
});
