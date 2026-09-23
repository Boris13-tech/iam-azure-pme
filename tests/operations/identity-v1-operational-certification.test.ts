import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IdentityRuntimeLifecycle,
  OPERATIONAL_COMPONENTS,
  evaluateIdentityReadiness,
  executeWithBoundedRetry,
  sanitizeOperationalFields,
  type ComponentSignal,
} from "../../lib/operations/identity-operational-readiness";

const checkedAt = "2026-09-23T00:00:00.000Z";
const healthy = (component: ComponentSignal["component"]): ComponentSignal => ({ component, state: "HEALTHY", checkedAt });
const baseSignals: ComponentSignal[] = OPERATIONAL_COMPONENTS.map(healthy);

describe("LUXIA Identity v1 operational certification", () => {
  it.each(["CLOUD", "HYBRID", "SOVEREIGN"] as const)("certifies %s readiness and fails closed", (profile) => {
    expect(evaluateIdentityReadiness(profile, baseSignals, new Date(checkedAt)).state).toBe("READY");
    const failed = baseSignals.map((signal) => signal.component === "DATABASE" ? { ...signal, state: "UNAVAILABLE" as const } : signal);
    expect(evaluateIdentityReadiness(profile, failed).state).toBe("NOT_READY");
  });

  it("degrades safely for external provider or sync loss", () => {
    const signals = baseSignals.map((signal) => signal.component === "EXTERNAL_PROVIDER" ?
      { ...signal, state: "UNAVAILABLE" as const, reasonCode: "PROVIDER_OUTAGE" } : signal);
    const result = evaluateIdentityReadiness("SOVEREIGN", signals);
    expect(result.state).toBe("DEGRADED");
    expect(result.alert).toBe("WARNING");
  });

  it("supports idempotent restart and controlled shutdown", () => {
    const lifecycle = new IdentityRuntimeLifecycle();
    expect(lifecycle.start()).toBe("STARTING");
    expect(lifecycle.start()).toBe("STARTING");
    expect(lifecycle.markReady(evaluateIdentityReadiness("CLOUD", baseSignals))).toBe("READY");
    expect(lifecycle.beginShutdown()).toBe("DRAINING");
    expect(lifecycle.beginShutdown()).toBe("DRAINING");
    expect(lifecycle.markStopped()).toBe("STOPPED");
    expect(lifecycle.markStopped()).toBe("STOPPED");
  });

  it("keeps readiness closed through a database outage and controlled restart", () => {
    const lifecycle = new IdentityRuntimeLifecycle(); lifecycle.start();
    const outage = baseSignals.map((signal) => signal.component === "DATABASE" ? { ...signal, state: "UNAVAILABLE" as const } : signal);
    expect(() => lifecycle.markReady(evaluateIdentityReadiness("SOVEREIGN", outage))).toThrow("RUNTIME_NOT_READY");
    expect(lifecycle.beginShutdown()).toBe("DRAINING"); expect(lifecycle.markStopped()).toBe("STOPPED");
    expect(lifecycle.start()).toBe("STARTING");
    expect(lifecycle.markReady(evaluateIdentityReadiness("SOVEREIGN", baseSignals))).toBe("READY");
  });

  it("bounds retries and reports only safe error codes", async () => {
    const observations: unknown[] = []; let attempts = 0;
    await expect(executeWithBoundedRetry(async () => { attempts += 1; throw Object.assign(new Error("secret"), { code: "UNAVAILABLE" }); },
      { maximumAttempts: 3, baseDelayMs: 5, maximumDelayMs: 10 },
      { retryable: () => true, sleep: async () => undefined, observe: (event) => observations.push(event) })).rejects.toThrow("secret");
    expect(attempts).toBe(3); expect(observations).toEqual([
      { attempt: 1, delayMs: 5, errorCode: "UNAVAILABLE" }, { attempt: 2, delayMs: 10, errorCode: "UNAVAILABLE" },
    ]);
  });

  it("redacts secrets from structured telemetry", () => {
    expect(sanitizeOperationalFields({ tenantId: "t1", token: "no", nested: { password: "no", state: "READY" } }))
      .toEqual({ tenantId: "t1", token: "[REDACTED]", nested: { password: "[REDACTED]", state: "READY" } });
  });

  it("meets the deterministic evaluation capacity baseline", () => {
    const started = performance.now();
    for (let index = 0; index < 10_000; index += 1) evaluateIdentityReadiness("HYBRID", baseSignals);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("has complete machine-readable evidence with no required N/A", () => {
    const report = JSON.parse(readFileSync("docs/operations/identity-v1-certification.json", "utf8")) as {
      profiles: Record<string, { result: string }>; gates: Array<{ id: string; required: boolean; result: string; evidence: string[] }>;
    };
    expect(Object.values(report.profiles).every((profile) => profile.result === "PASS")).toBe(true);
    expect(report.gates.length).toBeGreaterThanOrEqual(12);
    expect(report.gates.every((gate) => ["PASS", "FAIL", "NA"].includes(gate.result))).toBe(true);
    expect(report.gates.filter((gate) => gate.required).every((gate) => gate.result === "PASS" && gate.evidence.length > 0)).toBe(true);
  });
});
