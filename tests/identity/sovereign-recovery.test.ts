import { describe, expect, it } from "vitest";
import { activationEvidence, approveRecoveryCeremony, beginRecoveryCeremony, markRecoveryVerified,
  markRestoredInIsolation } from "../../lib/identity";
import { TestContinuityCrypto, scope } from "./continuity-test-kit";

describe("Phase 6G sovereign recovery ceremony", () => {
  it("requires two distinct approvals, isolated restore, and advances the epoch exactly once", async () => {
    const crypto = new TestContinuityCrypto();
    crypto.add("authority-a"); crypto.add("authority-b");
    let ceremony = beginRecoveryCeremony({ scope, packageId: "package-a", manifestDigest: "sha256:manifest",
      currentRecoveryEpoch: 4, isolatedEnvironment: true, now: new Date("2026-09-23T12:00:00.000Z") });
    ceremony = await approveRecoveryCeremony(ceremony, "authority-a", crypto);
    expect(ceremony.state).toBe("REQUESTED");
    await expect(approveRecoveryCeremony(ceremony, "authority-a", crypto)).rejects.toThrow("RECOVERY_REPLAY");
    ceremony = await approveRecoveryCeremony(ceremony, "authority-b", crypto);
    expect(ceremony.state).toBe("APPROVED");
    ceremony = markRestoredInIsolation(await markRecoveryVerified(ceremony, crypto));
    expect(activationEvidence(ceremony)).toMatchObject({ recoveryEpoch: 5 });
  });

  it("refuses non-isolated recovery and insufficient ceremony approval", async () => {
    expect(() => beginRecoveryCeremony({ scope, packageId: "p", manifestDigest: "sha256:m", currentRecoveryEpoch: 0,
      isolatedEnvironment: false })).toThrow("INVALID_SCOPE");
    const ceremony = beginRecoveryCeremony({ scope, packageId: "p", manifestDigest: "sha256:m", currentRecoveryEpoch: 0,
      isolatedEnvironment: true });
    await expect(markRecoveryVerified(ceremony, new TestContinuityCrypto())).rejects.toThrow("INVALID_FORMAT");
  });
});
