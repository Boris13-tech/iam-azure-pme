import { describe, expect, it } from "vitest";
import { CONTINUITY_MODES, assessContinuityUse, commitContinuityModeTransition, deriveContinuityMode, transitionContinuityMode } from "../../lib/identity";
import { MemoryContinuityStore, offlineState } from "./continuity-test-kit";

describe("Phase 6F continuity modes and safe degradation", () => {
  it("defines all modes and advances the epoch only when entering a partition envelope", () => {
    expect(CONTINUITY_MODES).toEqual(["CONNECTED", "DEGRADED", "PARTITIONED", "OFFLINE", "RECOVERING"]);
    const connected = { ...offlineState(), mode: "CONNECTED" as const, partitionEpoch: 7 };
    const degraded = transitionContinuityMode(connected, "DEGRADED", "2026-09-23T12:01:00.000Z");
    expect(degraded.partitionEpoch).toBe(7);
    const partitioned = transitionContinuityMode(degraded, "PARTITIONED", "2026-09-23T12:02:00.000Z");
    expect(partitioned.partitionEpoch).toBe(8);
    expect(transitionContinuityMode(partitioned, "OFFLINE", "2026-09-23T12:03:00.000Z").partitionEpoch).toBe(8);
  });

  it("requires completed reconciliation before RECOVERING can become CONNECTED", () => {
    const recovering = { ...offlineState(), mode: "RECOVERING" as const };
    expect(() => transitionContinuityMode(recovering, "CONNECTED", "2026-09-23T13:00:00.000Z")).toThrow("INVALID_MODE_TRANSITION");
    expect(transitionContinuityMode(recovering, "CONNECTED", "2026-09-23T13:00:00.000Z", true).mode).toBe("CONNECTED");
  });

  it("commits a mode transition and its evidence event together", async () => {
    const store = new MemoryContinuityStore(); const current = offlineState(); store.state = current;
    const next = await commitContinuityModeTransition({ scope: { organizationId: current.organizationId, tenantId: current.tenantId },
      current, nextMode: "RECOVERING", operationId: "reconnect", now: new Date("2026-09-23T13:00:00.000Z") }, store);
    expect(next.mode).toBe("RECOVERING"); expect(store.events[0]).toMatchObject({ eventType: "MODE_TRANSITION", reasonCode: "OFFLINE_TO_RECOVERING" });
  });

  it("degrades an Entra/provider outage without disabling the local runtime", () => {
    expect(deriveContinuityMode({ localRuntimeAvailable: true, internetAvailable: true, controlPlaneReachable: true, providerReachable: false })).toBe("DEGRADED");
    expect(deriveContinuityMode({ localRuntimeAvailable: true, internetAvailable: false, controlPlaneReachable: false, providerReachable: false })).toBe("OFFLINE");
    expect(assessContinuityUse("DEGRADED", "STANDARD", true)).toMatchObject({ authenticationAllowed: true, evidenceUse: "EXISTING_ACCESS_ONLY" });
  });

  it("never permits privilege increase outside CONNECTED mode", () => {
    for (const mode of ["DEGRADED", "PARTITIONED", "OFFLINE", "RECOVERING"] as const)
      expect(assessContinuityUse(mode, "PRIVILEGE_INCREASING", true)).toMatchObject({ evidenceUse: "NONE", reasonCode: "OFFLINE_PRIVILEGE_INCREASE_DENIED" });
  });
});
