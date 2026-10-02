import { describe, expect, it, vi } from "vitest";
import { continuityDigest, createSovereignExport, encryptSovereignBackup, planSovereignImport,
  restoreSovereignBackup, verifySovereignExport } from "../../lib/identity";
import { TestContinuityCrypto, scope } from "./continuity-test-kit";
import { MemoryBackupCustody, portableContent } from "./portability-test-kit";

const now = new Date("2026-09-23T12:00:00.000Z");
async function fixture() {
  const crypto = new TestContinuityCrypto();
  const pkg = await createSovereignExport({ scope, recoveryEpoch: 4, sourceDeploymentId: "edge-old",
    content: portableContent(), now, packageId: "package-a" }, crypto);
  return { crypto, pkg };
}

describe("Phase 6G sovereign export/import", () => {
  it("round-trips canonical identity, lifecycle, assignments and evidence deterministically", async () => {
    const { crypto, pkg } = await fixture();
    const verified = await verifySovereignExport(JSON.parse(JSON.stringify(pkg)), { scope, recoveryEpoch: 4 }, crypto);
    const plan = planSovereignImport({ pkg: verified, targetDeploymentId: "isolated-new", isolatedEnvironment: true,
      currentRecoveryEpoch: 4, providerReplacements: [{ sourceProviderConnectionId: "entra-old", targetProviderConnectionId: "luxia-local-new" }] });
    expect(verified.content.subjects[0]).toMatchObject({ id: "subject-alice", lifecycleState: "ACTIVE", lifecycleVersion: 7 });
    expect(verified.content.assignments[0].id).toBe("assignment-a");
    expect(verified.content.evidenceReferences[0].provenanceDigest).toBe("sha256:evidence-provenance");
    expect(plan.actions).toContainEqual(expect.objectContaining({ entityType: "IDENTITY_ACCOUNT", action: "REMAP_PROVIDER",
      targetProviderConnectionId: "luxia-local-new" }));
    expect(plan.actions).toContainEqual(expect.objectContaining({ entityId: "passkey-a", action: "REQUIRE_REENROLLMENT" }));
    expect(plan.actions).toContainEqual(expect.objectContaining({ entityId: "revoked-a", action: "PRESERVE_REVOKED" }));
    expect(plan.deterministicDigest).toBe(planSovereignImport({ pkg: verified, targetDeploymentId: "isolated-new", isolatedEnvironment: true,
      currentRecoveryEpoch: 4, providerReplacements: [{ sourceProviderConnectionId: "entra-old", targetProviderConnectionId: "luxia-local-new" }] }).deterministicDigest);
  });

  it("restores an encrypted backup without the original provider or network", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider unavailable"));
    const { crypto, pkg } = await fixture(); const custody = new MemoryBackupCustody();
    const encrypted = await encryptSovereignBackup(pkg, "custody://backup/key-1", custody);
    expect(JSON.stringify(encrypted)).not.toContain("Alice");
    const restored = await restoreSovereignBackup(encrypted, { scope, recoveryEpoch: 4 }, custody, crypto);
    expect(restored.content.subjects[0].id).toBe("subject-alice"); expect(network).not.toHaveBeenCalled(); network.mockRestore();
  });

  it("fails closed on tampering, wrong tenant, stale epoch and replay", async () => {
    const { crypto, pkg } = await fixture(); const custody = new MemoryBackupCustody();
    const encrypted = await encryptSovereignBackup(pkg, "custody://backup/key-1", custody);
    await expect(restoreSovereignBackup({ ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}aa` },
      { scope, recoveryEpoch: 4 }, custody, crypto)).rejects.toThrow("INTEGRITY_FAILURE");
    await expect(restoreSovereignBackup(encrypted, { scope: { ...scope, tenantId: "tenant-b" }, recoveryEpoch: 4 }, custody, crypto)).rejects.toThrow("INVALID_SCOPE");
    await expect(verifySovereignExport(pkg, { scope, recoveryEpoch: 5 }, crypto)).rejects.toThrow("STALE_RECOVERY_EPOCH");
    await expect(verifySovereignExport(pkg, { scope, recoveryEpoch: 4, seenPackageIds: new Set(["package-a"]) }, crypto)).rejects.toThrow("RECOVERY_REPLAY");
  });

  it("quarantines duplicate IDs with divergent state and never merges by display name", async () => {
    const { pkg } = await fixture();
    const existing = new Map([["SUBJECT:subject-alice", continuityDigest({ id: "subject-alice", lifecycleState: "DISABLED" })]]);
    const plan = planSovereignImport({ pkg, targetDeploymentId: "isolated-new", isolatedEnvironment: true,
      currentRecoveryEpoch: 4, existingEntityDigests: existing });
    expect(plan.conflicts).toEqual([expect.objectContaining({ entityType: "SUBJECT", entityId: "subject-alice",
      action: "QUARANTINE", reasonCode: "DUPLICATE_ID_DIFFERENT_CONTENT" })]);
  });

  it("rejects accidental secret or private-key material in an export", async () => {
    const crypto = new TestContinuityCrypto(); const content = portableContent() as unknown as Record<string, unknown>;
    content.privateKey = "forbidden";
    await expect(createSovereignExport({ scope, recoveryEpoch: 4, sourceDeploymentId: "edge", content: content as never }, crypto))
      .rejects.toThrow("SECRET_MATERIAL_FORBIDDEN");
  });
});
