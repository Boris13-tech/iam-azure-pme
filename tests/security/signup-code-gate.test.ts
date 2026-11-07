import { describe, expect, it } from "vitest";
import { checkSignupPlan, planSignupCode, SIGNUP_PLAN_VALIDITY_MS, SignupPlanRefusal } from "../../scripts/operators/signup-codes";
import { planDigest } from "../../lib/operators/break-glass";

// Standard, section 10: issuing a signup code (a Production write) needs a plan, its digest as the
// confirmation, the same database and tool commit, and a fresh plan.
const target = { host: "ep-example.eu-central-1.aws.neon.tech", database: "neondb", schema: "public", role: "neondb_owner" };
const commit = "a".repeat(40);
const at = new Date("2026-10-23T10:00:00.000Z");
const made = () => planSignupCode({ by: "operator", days: "14", note: "pilot one" }, target, commit, at);
const refusal = (fn: () => unknown) => { try { fn(); } catch (error) { return error instanceof SignupPlanRefusal ? error.message : `OTHER ${String(error)}`; } return "ACCEPTED"; };

describe("signup-code issuance gate", () => {
  it("plans without writing and binds the plan to its target, commit and validity window", () => {
    const { plan, digest } = made();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan).toMatchObject({ by: "operator", days: 14, note: "pilot one", target, toolVersion: commit });
    expect(Date.parse(plan.notAfter) - Date.parse(plan.issuedAt)).toBe(SIGNUP_PLAN_VALIDITY_MS);
    expect(made().digest).toBe(digest);
  });

  it("refuses invalid inputs and an unknown tool commit", () => {
    expect(refusal(() => planSignupCode({ days: "14" }, target, commit, at))).toBe("BY_REQUIRED");
    expect(refusal(() => planSignupCode({ by: "x".repeat(201) }, target, commit, at))).toBe("BY_REQUIRED");
    for (const days of ["0", "31", "1.5", "abc"]) expect(refusal(() => planSignupCode({ by: "operator", days }, target, commit, at))).toBe("DAYS_OUT_OF_RANGE");
    expect(refusal(() => planSignupCode({ by: "operator" }, target, "unknown", at))).toBe("TOOL_VERSION_UNKNOWN");
  });

  it("accepts only the intact plan, confirmed by its digest, fresh, on the same database and commit", () => {
    const { plan, digest } = made();
    const current = { target, toolVersion: commit };
    expect(checkSignupPlan({ plan, digest }, digest, current, at)).toEqual(plan);
    expect(refusal(() => checkSignupPlan({ plan, digest }, undefined, current, at))).toBe("CONFIRMATION_MISMATCH");
    expect(refusal(() => checkSignupPlan({ plan, digest }, "0".repeat(64), current, at))).toBe("CONFIRMATION_MISMATCH");
    expect(refusal(() => checkSignupPlan({ plan: { ...plan, days: 30 }, digest }, digest, current, at))).toBe("PLAN_TAMPERED");
    expect(refusal(() => checkSignupPlan({ plan: { ...plan, notAfter: "2099-01-01T00:00:00.000Z" }, digest }, digest, current, at))).toBe("PLAN_TAMPERED");
    expect(refusal(() => checkSignupPlan({ plan, digest }, digest, current, new Date(at.getTime() + SIGNUP_PLAN_VALIDITY_MS + 1)))).toBe("PLAN_EXPIRED");
    expect(refusal(() => checkSignupPlan({ plan, digest }, digest, { target: { ...target, host: "ep-other.neon.tech" }, toolVersion: commit }, at))).toBe("TARGET_MISMATCH");
    expect(refusal(() => checkSignupPlan({ plan, digest }, digest, { target: { ...target, database: "other" }, toolVersion: commit }, at))).toBe("TARGET_MISMATCH");
    expect(refusal(() => checkSignupPlan({ plan, digest }, digest, { target: { ...target, schema: "other" }, toolVersion: commit }, at))).toBe("TARGET_MISMATCH");
    expect(refusal(() => checkSignupPlan({ plan, digest }, digest, { target: { ...target, host: `${target.host}:5433` }, toolVersion: commit }, at))).toBe("TARGET_MISMATCH");
    expect(refusal(() => checkSignupPlan({ plan, digest }, digest, { target, toolVersion: "b".repeat(40) }, at))).toBe("TOOL_VERSION_MISMATCH");
    expect(refusal(() => checkSignupPlan({ digest }, digest, current, at))).toBe("NOT_A_SIGNUP_PLAN");
    expect(refusal(() => checkSignupPlan(null, digest, current, at))).toBe("NOT_A_SIGNUP_PLAN");
  });

  it("a plan rebuilt by hand is refused even with its digest recomputed and confirmed: window, start and days", () => {
    const { plan } = made();
    const current = { target, toolVersion: commit };
    const forged = (changes: Partial<typeof plan>) => { const p = { ...plan, ...changes }; const d = planDigest(p); return refusal(() => checkSignupPlan({ plan: p, digest: d }, d, current, at)); };
    expect(forged({ issuedAt: "2026-10-22T10:00:00.000Z", notAfter: "2026-10-24T10:00:00.000Z" })).toBe("PLAN_WINDOW_INVALID"); // 48 hours
    expect(forged({ issuedAt: "2026-10-23T11:00:00.000Z", notAfter: "2026-10-23T11:15:00.000Z" })).toBe("PLAN_WINDOW_INVALID"); // starts in the future
    expect(forged({ issuedAt: "not a date" })).toBe("PLAN_WINDOW_INVALID");
    expect(forged({ days: 365 })).toBe("DAYS_OUT_OF_RANGE");
    expect(forged({ note: "another note" })).toBe("ACCEPTED"); // a legitimate change, confirmed, stays possible
  });
});
